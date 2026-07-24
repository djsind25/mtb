-- Batch of small hauler/admin UX fixes:
--   1. job_questions_insert gains the same license/insurance eligibility check bids_insert has
--      (asking was deliberately a lower bar than bidding — tightening it to match, per request).
--   2. public_profiles exposes created_at, so a "member since" display can be built (client-side
--      keeps it hidden for now via a feature flag — this just makes the data available).
--   3. list_open_jobs_for_hauler gains a zip_geo join so Browse Jobs can show the job's town next
--      to its ZIP. zip_geo.city/state are only populated for the ~29 original Homer Glen, IL
--      launch-market ZIPs (see 20260706221657_storage_and_seed.sql) — the nationwide ZCTA import
--      (20260717180000_nationwide_zip_geo.sql) only ever backfilled lat/lng, so most jobs will
--      still show a null city/state here until a real nationwide backfill happens.
--   4. New list_my_bid_jobs_for_hauler(), giving "My Bids" the same zip_geo join plus a true
--      bid_count. bids_select RLS restricts a hauler to only their own bid rows (sealed bidding),
--      so a client-side count over the bids table from "My Bids" would silently return 0 or 1,
--      not the real total — this needs the same security-definer bypass
--      list_open_jobs_for_hauler already uses, scoped to only the calling hauler's own jobs.

-- ── 1. Tighten job_questions_insert ─────────────────────────────────────────────
drop policy job_questions_insert on job_questions;
create policy job_questions_insert on job_questions for insert with check (
  hauler_id = auth.uid() and is_active_user() and job_is_open_for_bid(job_id)
  and hauler_within_radius_of_job(job_id)
  and exists (
    select 1 from profiles
    where profiles.id = auth.uid() and profiles.role = 'hauler'
      and profiles.license_active and profiles.insurance_active
  )
  and (select count(*) from job_questions q
       where q.job_id = job_questions.job_id and q.hauler_id = auth.uid() and q.answer is null) < 3
);

-- ── 2. public_profiles gains created_at ─────────────────────────────────────────
create or replace view public_profiles as
  select id, role, name, business_name, avatar, verified, rating, rating_count,
    license_active, insurance_active, created_at
  from profiles;

-- ── 3. list_open_jobs_for_hauler gains a zip_geo join (town next to ZIP) ────────
drop function if exists list_open_jobs_for_hauler();
create function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  created_at timestamptz, expires_at timestamptz, bid_count bigint, distance_mi numeric,
  photo_count bigint, city text, state text
)
language plpgsql security definer set search_path = public as $$
declare
  v_hauler profiles%rowtype;
  v_radius numeric;
begin
  select * into v_hauler from profiles where profiles.id = auth.uid();
  if v_hauler.id is null or v_hauler.role <> 'hauler' then
    raise exception 'Only hauler accounts can browse open jobs';
  end if;
  if not v_hauler.active then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  v_radius := app_config_numeric('max_radius_mi');

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode, j.created_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count,
      z.city, z.state
    from jobs j
    left join zip_geo z on z.zip = j.zip
    where j.status = 'open' and j.expires_at > now()
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;
grant execute on function list_open_jobs_for_hauler() to authenticated;

-- ── 4. New list_my_bid_jobs_for_hauler() — full job row + town + real bid_count ─
-- Returns the whole jobs row as a composite column ("job") instead of hand-duplicating every
-- jobs column in the function signature, so this stays correct as the jobs table evolves — the
-- client flattens it with `{ ...row.job, city: row.city, state: row.state, bid_count: row.bid_count }`.
create or replace function list_my_bid_jobs_for_hauler()
returns table (job jobs, city text, state text, bid_count bigint)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select j, z.city, z.state, (select count(*) from bids b2 where b2.job_id = j.id) as bid_count
    from jobs j
    left join zip_geo z on z.zip = j.zip
    where exists (select 1 from bids b where b.job_id = j.id and b.hauler_id = auth.uid());
end;
$$;
grant execute on function list_my_bid_jobs_for_hauler() to authenticated;
