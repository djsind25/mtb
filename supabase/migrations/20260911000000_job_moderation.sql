-- MyTrashBid — Admin Job Moderation
--
-- Two admin tools for handling bogus/suspicious job posts: "Remove job" (quick soft-remove for
-- obvious spam) and "Flag — needs more info to renew" (pauses a borderline post, recoverable by
-- the customer). No hard delete — same soft-action + audit-log shape as account deletion/
-- suspension (20260815000000_account_deletion_and_suspension.sql), which this migration mirrors
-- closely: an append-only audit log, a guard-trigger column blocklist locking the new fields to
-- RPC-only, is_full_admin()+require_aal2() on every mutating call, a required reason.
--
-- Design choice called out by the spec as open ("build the simpler of these two"): on resubmit,
-- flagged_needs_info clears automatically (treated as a renewal) rather than routing back through
-- a second admin-review queue. This app already has no general "edit job title/description" RPC —
-- guard_job_self_update() only ever allowed the client to touch `timeline` directly — so "add/
-- correct information" reuses the existing job_updates addendum feature (the same "Add job
-- details" log customers already post to, visible to bidders) rather than inventing a new edit
-- surface. resolve_job_flag_and_resubmit() requires at least one job_updates row created after
-- moderated_at, so a customer can't clear the flag without actually adding something, and then
-- refreshes the live window the same way renew_job() does. This is simpler than a second review
-- queue and needed no new admin UI to gate it.

-- ─── 1. jobs: moderation columns ────────────────────────────────────────────────────────────────

alter table jobs
  add column moderation_status text check (moderation_status in ('removed', 'flagged_needs_info')),
  add column moderated_at timestamptz,
  add column moderated_by_admin_id uuid references profiles(id),
  add column moderation_reason text;

create index jobs_moderation_status_idx on jobs (moderation_status) where moderation_status is not null;

-- ─── 2. guard_job_self_update() — lock the new columns to RPC-only, same idiom as the account-
--    lifecycle columns on profiles. Byte-for-byte identical to the current
--    20260716114528_job_timeline.sql definition otherwise. ────────────────────────────────────────

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

  if new.moderation_status is distinct from old.moderation_status
    or new.moderated_at is distinct from old.moderated_at
    or new.moderated_by_admin_id is distinct from old.moderated_by_admin_id
    or new.moderation_reason is distinct from old.moderation_reason
  then
    raise exception 'Not permitted to change this field.';
  end if;

  if (to_jsonb(new) - 'timeline' - 'timeline_date') <> (to_jsonb(old) - 'timeline' - 'timeline_date') then
    raise exception 'Not permitted to change this field.';
  end if;

  return new;
end;
$$;

-- ─── 3. Gate public/hauler visibility on moderation_status — widen the two functions every
--    hauler-facing "is this job biddable/visible" check already goes through, rather than
--    threading a new condition through each call site individually. ───────────────────────────────

create or replace function job_is_open_for_bid(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from jobs
      where jobs.id = p_job_id and jobs.status = 'open' and jobs.expires_at > now()
        and jobs.moderation_status is null
    );
  $$;

-- job_updates_insert's RLS policy was built on job_is_open_for_bid() (see
-- 20260728000000_job_qna.sql) — widening that function above to exclude flagged jobs would have
-- also blocked the customer from posting the very addendum resolve_job_flag_and_resubmit()
-- requires, a chicken-and-egg deadlock. job_updates only ever needs "is this job still open and
-- unexpired", never the hauler-bid-specific moderation gate, so it gets its own narrower check
-- instead of sharing job_is_open_for_bid() — allowed while flagged (that's the whole point), still
-- blocked once removed or expired.
create function job_open_for_updates(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from jobs
      where jobs.id = p_job_id and jobs.status = 'open' and jobs.expires_at > now()
        and coalesce(jobs.moderation_status, '') <> 'removed'
    );
  $$;

drop policy job_updates_insert on job_updates;
create policy job_updates_insert on job_updates for insert with check (
  customer_owns_job(job_id) and is_active_user() and job_open_for_updates(job_id)
);

-- list_open_jobs_for_hauler(): byte-for-byte identical to the current
-- 20260824000000_security_review_fixes.sql definition (the latest one, including timeline_date),
-- just adding the moderation filter to the WHERE clause.
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

-- ─── 4. job_moderation_audit_log — append-only, same idiom as account_lifecycle_audit_log. ───────

create table job_moderation_audit_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references profiles(id),  -- null only for the system-driven resubmit-clear
  job_id        uuid not null references jobs(id),
  action        text not null check (action in ('removed', 'flagged_needs_info', 'flag_cleared_resubmit')),
  reason        text,
  bidder_count  int not null default 0,
  created_at    timestamptz not null default now()
);
create index job_moderation_audit_log_job_idx on job_moderation_audit_log (job_id);
create index job_moderation_audit_log_created_idx on job_moderation_audit_log (created_at desc);

alter table job_moderation_audit_log enable row level security;
grant select on job_moderation_audit_log to authenticated;
create policy job_moderation_audit_log_select on job_moderation_audit_log for select using (is_admin());
-- No insert/update/delete policy — append-only, written exclusively by log_job_moderation_event()
-- (security definer, never granted to authenticated).

create function log_job_moderation_event(
  p_job_id uuid, p_actor_id uuid, p_action text, p_reason text, p_bidder_count int
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into job_moderation_audit_log (job_id, actor_id, action, reason, bidder_count)
  values (p_job_id, p_actor_id, p_action, p_reason, coalesce(p_bidder_count, 0));
end;
$$;
revoke execute on function log_job_moderation_event(uuid, uuid, text, text, int) from public;

-- ─── 5. Hauler notifications on removal/flag — same dispatch_notification_email/sms shape every
--    other notification in this codebase uses. No existing "job expired" notification exists to
--    mirror (job expiry is a silent, display-only state today — expiryLabel()/isExpired() are
--    client-side only), so this follows the standard bidReceived-style insert+dispatch pattern.

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered',
  'bidRevisionProposed', 'bidRevisionResolved',
  'scheduleProposed', 'scheduleConfirmed', 'coordinationNudge', 'paymentAuthorized',
  'supportRequested', 'adminJoined', 'supportResolved', 'chatLocked', 'chatUnlocked',
  'disputeOpened', 'disputeResolved', 'jobRemoved', 'jobPaused'
]));

-- ─── 6. admin_remove_job() ──────────────────────────────────────────────────────────────────────

create function admin_remove_job(p_job_id uuid, p_reason text, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bidder record;
  v_bidder_count int;
  v_notif_id uuid;
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can remove a job.';
  end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to remove a job.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  -- Booked jobs have an active hauler relationship — route through the existing cancellation-
  -- request/admin-review flow instead of a quick remove.
  if v_job.status = 'booked' then
    raise exception 'BOOKED_JOB_USE_CANCELLATION: This job is booked — use the cancellation review flow instead of Remove.';
  end if;
  if v_job.moderation_status = 'removed' then
    raise exception 'This job has already been removed.';
  end if;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    moderation_status = 'removed', moderated_at = now(), moderated_by_admin_id = auth.uid(), moderation_reason = p_reason
  where id = p_job_id;

  select count(*) into v_bidder_count from bids where job_id = p_job_id;

  -- Courtesy notice to every hauler who bid — don't let a job just vanish out from under them.
  for v_bidder in select distinct hauler_id from bids where job_id = p_job_id
  loop
    insert into notifications (user_id, event_type, title, body, job_id)
    values (v_bidder.hauler_id, 'jobRemoved', 'A job you bid on was removed',
      format('"%s" was removed by MyTrashBid and is no longer available.', v_job.title), p_job_id)
    returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
    perform dispatch_notification_sms(v_notif_id);
  end loop;

  perform log_job_moderation_event(p_job_id, auth.uid(), 'removed', p_reason, v_bidder_count);
end;
$$;
revoke execute on function admin_remove_job(uuid, text, text) from public;
grant execute on function admin_remove_job(uuid, text, text) to authenticated;

-- ─── 7. admin_flag_job_needs_info() ─────────────────────────────────────────────────────────────

create function admin_flag_job_needs_info(p_job_id uuid, p_reason text, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bidder record;
  v_bidder_count int;
  v_notif_id uuid;
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can flag a job.';
  end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to flag a job.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.status <> 'open' then
    raise exception 'Only an open job can be flagged for more information.';
  end if;
  if v_job.moderation_status is not null then
    raise exception 'This job already has a moderation action on it.';
  end if;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    moderation_status = 'flagged_needs_info', moderated_at = now(), moderated_by_admin_id = auth.uid(), moderation_reason = p_reason
  where id = p_job_id;

  select count(*) into v_bidder_count from bids where job_id = p_job_id;

  -- Softer message than removal — this job isn't dead, just paused pending the customer's follow-up.
  for v_bidder in select distinct hauler_id from bids where job_id = p_job_id
  loop
    insert into notifications (user_id, event_type, title, body, job_id)
    values (v_bidder.hauler_id, 'jobPaused', 'A job you bid on is temporarily paused',
      format('"%s" is paused pending follow-up from the customer — it may come back live.', v_job.title), p_job_id)
    returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
  end loop;

  perform log_job_moderation_event(p_job_id, auth.uid(), 'flagged_needs_info', p_reason, v_bidder_count);
end;
$$;
revoke execute on function admin_flag_job_needs_info(uuid, text, text) from public;
grant execute on function admin_flag_job_needs_info(uuid, text, text) to authenticated;

-- ─── 8. Customer-side resubmit — clears the flag once the customer has actually added something
--    via the existing job_updates addendum, then refreshes the live window the same way
--    renew_job() does. ───────────────────────────────────────────────────────────────────────────

create function resolve_job_flag_and_resubmit(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> auth.uid() then
    raise exception 'Only the job owner can resubmit this listing';
  end if;
  if v_job.moderation_status <> 'flagged_needs_info' then
    raise exception 'This job is not currently flagged for more information.';
  end if;
  if not exists (select 1 from job_updates where job_id = p_job_id and created_at > v_job.moderated_at) then
    raise exception 'Add the requested information below before resubmitting.';
  end if;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    moderation_status = null, moderated_at = null, moderated_by_admin_id = null, moderation_reason = null,
    created_at = now(), expires_at = now() + make_interval(days => app_config_numeric('live_window_days')::int)
  where id = p_job_id;

  perform log_job_moderation_event(p_job_id, null, 'flag_cleared_resubmit', null, 0);
end;
$$;
revoke execute on function resolve_job_flag_and_resubmit(uuid) from public;
grant execute on function resolve_job_flag_and_resubmit(uuid) to authenticated;

-- ─── 9. Moderation history read, for the admin job drill-down. ────────────────────────────────────

create function job_moderation_history(p_job_id uuid)
returns table (id uuid, actor_id uuid, action text, reason text, bidder_count int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.id, l.actor_id, l.action, l.reason, l.bidder_count, l.created_at
  from job_moderation_audit_log l
  where l.job_id = p_job_id and is_admin()
  order by l.created_at desc;
$$;
revoke execute on function job_moderation_history(uuid) from public;
grant execute on function job_moderation_history(uuid) to authenticated;
