-- "We deliberately required photos to post a job for bid" was only ever true client-side —
-- PostJobForm.jsx refuses to submit without one, but postJob() inserts the jobs row and uploads
-- photos as two separate, non-atomic calls (the photo path is `${job.id}/...`, so a photo can't
-- exist before the job row does), and nothing server-side ever checked a job actually got one.
-- Confirmed live: a job created with zero photos (bypassing the form) was fully bid-able and
-- showed up in Browse Jobs like any other.
--
-- Rather than bolt a photo requirement onto job creation itself (which the id-ordering above
-- makes awkward), widen the same two chokepoints 20260911000000_job_moderation.sql already used
-- for the identical shape of problem (moderation_status): job_is_open_for_bid() — the single-job
-- gate behind bids_insert, job Q&A, and job_photos visibility — and list_open_jobs_for_hauler()'s
-- Browse Jobs query. A job with no photo is now simply never "open for bid" anywhere, regardless
-- of how it was created, and starts appearing the moment a photo is attached — no separate
-- "publish" step needed, and the customer's own view of their own job (customer_owns_job(), a
-- separate unconditional check everywhere) is untouched, so they can always come back and add one.

create or replace function job_is_open_for_bid(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from jobs
      where jobs.id = p_job_id and jobs.status = 'open' and jobs.expires_at > now()
        and jobs.moderation_status is null
        and exists (select 1 from job_photos jp where jp.job_id = jobs.id)
    );
  $$;

create or replace function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date, timeline text,
  timeline_date date, created_at timestamptz, first_posted_at timestamptz, expires_at timestamptz,
  bid_count bigint, distance_mi numeric, photo_count bigint, city text, state text, is_dismissed boolean
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
  if not (v_hauler.active and v_hauler.status = 'active') then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  v_radius := membership_max_radius_mi(v_hauler.membership_tier);

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode,
      j.service_type, j.dumpster_type, j.rental_start_date, j.rental_end_date, j.timeline, j.timeline_date,
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
    where j.status = 'open' and j.expires_at > now() and j.moderation_status is null
      and exists (select 1 from job_photos jp where jp.job_id = j.id)
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
