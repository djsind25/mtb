-- Replace the "Flexible / no rush" timeline option with "Specific date", backed by an actual
-- calendar date the customer picks. No existing date-valued column fits this — rental_start_date/
-- rental_end_date are rental-specific and set by a completely different form path.
alter table jobs add column timeline_date date;

alter table jobs drop constraint jobs_timeline_check;

-- Existing 'flexible' jobs would now violate the new check constraint — reclassify them to the
-- closest remaining non-urgent bucket before the constraint goes back on.
update jobs set timeline = 'this_month' where timeline = 'flexible';

alter table jobs add constraint jobs_timeline_check
  check (timeline in ('asap', 'this_week', 'next_2_weeks', 'this_month', 'specific_date'));

alter table jobs add constraint jobs_timeline_date_consistency check (
  (timeline = 'specific_date' and timeline_date is not null)
  or (timeline is distinct from 'specific_date' and timeline_date is null)
);

-- guard_job_self_update() (20260717010000_view_only_admin.sql) only ever whitelisted a bare
-- `timeline` self-edit — widen it to cover `timeline_date` too, locked together the same way.
create or replace function guard_job_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or auth.role() = 'service_role'
    or coalesce(current_setting('app.bypass_job_guard', true), '') = 'true'
  then
    return new;
  end if;

  if old.status = 'booked'
    and (new.timeline is distinct from old.timeline or new.timeline_date is distinct from old.timeline_date)
  then
    raise exception 'Timeline can only be changed before a bid is accepted.';
  end if;

  if (to_jsonb(new) - 'timeline' - 'timeline_date') <> (to_jsonb(old) - 'timeline' - 'timeline_date') then
    raise exception 'Not permitted to change this field.';
  end if;

  return new;
end;
$$;

-- list_open_jobs_for_hauler() (20260804000000_hauler_dashboard_enhancements.sql) returns an
-- explicit column list rather than the composite `job jobs` shape list_my_bid_jobs_for_hauler()
-- uses, so timeline_date doesn't flow through automatically — widen it here.
drop function if exists list_open_jobs_for_hauler();
create function list_open_jobs_for_hauler()
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
  if not v_hauler.active then
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
