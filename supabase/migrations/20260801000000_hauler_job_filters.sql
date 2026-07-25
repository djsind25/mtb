-- Find Jobs filtering/sorting/saved-views/dismiss for the hauler Browse Jobs tab. Everything here
-- narrows the set list_open_jobs_for_hauler already returns (radius + tier already enforced there)
-- — no new visibility, purely display/preference plumbing.
--
-- Also fixes a real regression: the 20260729000000_hauler_ux_fixes.sql rewrite of
-- list_open_jobs_for_hauler (adding the zip_geo join) dropped the service_type/dumpster_type/
-- rental_start_date/rental_end_date/timeline columns that 20260716114528_job_timeline.sql had
-- added — since then, every open job has silently looked like a non-rental job with no timeline
-- to the client (HaulerJobCard's isRental/timeline badge, and HaulerDashboard's timeline filter,
-- were reading undefined). Restoring them here since this migration already has to
-- drop-and-recreate the function for the new columns below.

alter table profiles add column job_search_prefs jsonb;

-- Per-hauler-only hide list. Not exposed to admins/other haulers by design — "not interested" is
-- a personal browsing preference, not a signal about the job itself.
create table hauler_dismissed_jobs (
  hauler_id    uuid not null references profiles(id) on delete cascade,
  job_id       uuid not null references jobs(id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (hauler_id, job_id)
);
alter table hauler_dismissed_jobs enable row level security;
create policy hauler_dismissed_jobs_select on hauler_dismissed_jobs for select using (hauler_id = auth.uid());
create policy hauler_dismissed_jobs_insert on hauler_dismissed_jobs for insert with check (hauler_id = auth.uid());
create policy hauler_dismissed_jobs_delete on hauler_dismissed_jobs for delete using (hauler_id = auth.uid());
grant select, insert, delete on hauler_dismissed_jobs to authenticated;

drop function if exists list_open_jobs_for_hauler();
create function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date, timeline text,
  created_at timestamptz, expires_at timestamptz, bid_count bigint, distance_mi numeric,
  photo_count bigint, city text, state text, is_dismissed boolean
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
  v_radius := membership_max_radius_mi(v_hauler.membership_tier);

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode,
      j.service_type, j.dumpster_type, j.rental_start_date, j.rental_end_date, j.timeline,
      j.created_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count,
      z.city, z.state,
      exists(select 1 from hauler_dismissed_jobs d where d.job_id = j.id and d.hauler_id = auth.uid()) as is_dismissed
    from jobs j
    left join zip_geo z on z.zip = j.zip
    where j.status = 'open' and j.expires_at > now()
      -- Already-bid jobs belong in My Bids, not Find Jobs.
      and not exists (select 1 from bids b2 where b2.job_id = j.id and b2.hauler_id = auth.uid())
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;
grant execute on function list_open_jobs_for_hauler() to authenticated;
