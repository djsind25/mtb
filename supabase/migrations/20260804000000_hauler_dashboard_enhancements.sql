-- Hauler dashboard UX batch: stable "date posted" separate from renewals, plus a customer name
-- on the hauler's own bid list so ReviewPanel can be embedded directly on a completed job card
-- (it already needs `chat.customerName`/`chat.businessName` for its "how was working with X"
-- copy — see web/src/chat/ReviewPanel.jsx).
--
-- renew_job() (20260716114528_job_timeline.sql:42) only ever touches created_at/expires_at, so
-- first_posted_at stays untouched by any future renewal once backfilled here — created_at keeps
-- meaning "last (re)posted" exactly as it does today.

alter table jobs add column first_posted_at timestamptz;
-- guard_job_self_update() blocks direct field changes on jobs outside the app's own RPCs
-- (renew_job, etc.) — this one-time backfill needs the same bypass those RPCs use internally.
select set_config('app.bypass_job_guard', 'true', true);
update jobs set first_posted_at = created_at where first_posted_at is null;
alter table jobs alter column first_posted_at set not null;
alter table jobs alter column first_posted_at set default now();

drop function if exists list_open_jobs_for_hauler();
create function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date, timeline text,
  created_at timestamptz, first_posted_at timestamptz, expires_at timestamptz, bid_count bigint,
  distance_mi numeric, photo_count bigint, city text, state text, is_dismissed boolean
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
      j.created_at, j.first_posted_at, j.expires_at,
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

-- Widen the hauler's own bid-list RPC with the customer's display name, purely so the client can
-- pass it straight into ReviewPanel without a second round-trip. `job jobs` already returns the
-- whole row as a composite, so first_posted_at flows through automatically — no separate change
-- needed for that column here.
drop function if exists list_my_bid_jobs_for_hauler();
create function list_my_bid_jobs_for_hauler()
returns table (job jobs, city text, state text, bid_count bigint, customer_name text)
language plpgsql security definer set search_path = public as $$
begin
  return query
    select j, z.city, z.state, (select count(*) from bids b2 where b2.job_id = j.id), p.name
    from jobs j
    left join zip_geo z on z.zip = j.zip
    left join profiles p on p.id = j.customer_id
    where exists (select 1 from bids b where b.job_id = j.id and b.hauler_id = auth.uid());
end;
$$;
grant execute on function list_my_bid_jobs_for_hauler() to authenticated;
