-- MyTrashBid — full-payment scheduling & authorization flow
--
-- Replaces "charge the whole bid amount the moment it's accepted" (full-payment mode's behavior
-- since 20260722000000_full_payment_mode.sql) with a coordinate-then-hold model:
--
--   bid accepted -> chat opens, NO money moves
--   -> either party proposes a service date + final price in chat; the other confirms -> locked
--   -> if no date locked within 48h, both parties are nudged and the window extends once (+48h);
--      if still not locked after ~96h total, the job is flagged "stalled" for admin review
--      (never auto-cancelled)
--   -> 48h before the locked service date (or immediately, if that's already <48h away when
--      locked), the amount is "authorized" (a hold — simulated here, see the real-Stripe map at
--      the bottom of this comment)
--   -> at hauler_mark_done + customer_acknowledge_completion (existing dual-confirmation flow,
--      unchanged), the hold is "captured" — platform keeps 10%, rest is the hauler's
--
-- Deposit mode is completely untouched — every branch below is gated on payment_mode = 'full'.
--
-- Append-only: schedule_proposals is a ledger (ONE pending proposal per chat at a time, superseded
-- rather than overwritten — same shape as bid_revisions), and the "current" columns added to
-- chats are themselves next in a long line of guard_chat_self_update-protected, RPC-only-written
-- state (hauler_done_at/customer_ack_at etc. already work this way). No client can hand-edit any
-- of this directly.
--
-- No background scheduler in this prototype (per the spec) — coordination-deadline nudges/stalls
-- and the 48h-before-service authorization are both computed lazily by sync_full_payment_schedule(),
-- called opportunistically whenever a hauler or customer's job list loads (see jobs/data.js). This
-- mirrors the existing computed-from-timestamps pattern (job expiry, overdue-completion labels)
-- rather than the cron pattern used for daily digests elsewhere in this app — deliberately, since
-- the spec calls for "surface the nudge in-app when the party next opens the job," not a push.
--
-- Which points become real Stripe calls when this goes live (see the summary at the end of this
-- session for the full writeup):
--   perform_authorization()  -> stripe.paymentIntents.create({ capture_method: 'manual', ... })
--   finalize_completion()'s capture step -> stripe.paymentIntents.capture(id)
--   admin releasing a pre-capture hold (job_refundable_charges/resolve_cancellation, kind='authorization')
--     -> stripe.paymentIntents.cancel(id) for a full release, or a smaller .capture({amount_to_capture})
--        for a partial one
-- Every simulated authorization below is recorded with a stripe_payment_intent_id placeholder
-- prefixed 'sim_auth_' specifically so those call sites are easy to grep for later.

-- ── 1. Append-only proposal ledger ──────────────────────────────────────────────
create table schedule_proposals (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references jobs(id) on delete cascade,
  chat_id        uuid not null references chats(id) on delete cascade,
  proposed_by    uuid not null references profiles(id),
  proposed_role  text not null check (proposed_role in ('customer', 'hauler')),
  service_date   date not null,
  final_price    numeric(10,2) not null check (final_price > 0),
  status         text not null default 'pending' check (status in ('pending', 'confirmed', 'superseded')),
  confirmed_by   uuid references profiles(id),
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index schedule_proposals_chat_id_idx on schedule_proposals (chat_id);
-- One live proposal per chat — a second proposal while one's pending supersedes it rather than
-- creating two competing "confirm me" targets (see propose_schedule below).
create unique index schedule_proposals_chat_id_pending_key on schedule_proposals (chat_id) where status = 'pending';

alter table schedule_proposals enable row level security;
grant select on schedule_proposals to authenticated;
-- No insert/update grant — every write goes through propose_schedule()/confirm_schedule(), same
-- shape as bid_revisions/cancellation_requests.
create policy schedule_proposals_select on schedule_proposals for select using (
  is_admin()
  or exists (select 1 from jobs where jobs.id = schedule_proposals.job_id and jobs.customer_id = auth.uid())
  or exists (select 1 from chats where chats.id = schedule_proposals.chat_id and chats.hauler_id = auth.uid())
);

-- ── 2. Current-state columns on chats ───────────────────────────────────────────
alter table chats
  add column coordination_deadline    timestamptz,  -- accept_at + 48h for full-mode jobs; null once locked or for deposit-mode/legacy jobs
  add column coordination_extended_at timestamptz,   -- set once, the first time the deadline is crossed with no date locked (the "nudge" moment)
  add column stalled_at               timestamptz,   -- set once, the second time the (extended) deadline is crossed
  add column locked_service_date      date,
  add column locked_final_price       numeric(10,2),
  add column locked_proposal_id       uuid references schedule_proposals(id),
  add column authorize_at             timestamptz,   -- locked_service_date - 48h, computed at lock time
  add column authorized_at            timestamptz,
  add column captured_at              timestamptz;

-- Extends the existing allow-list guard (job_completion_workflow) so none of the above are
-- self-editable by either party — every write below goes through app.bypass_chat_guard.
create or replace function guard_chat_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or coalesce(current_setting('app.bypass_chat_guard', true), '') = 'true' then
    return new;
  end if;
  if new.bid_amount is distinct from old.bid_amount
    or new.deposit is distinct from old.deposit
    or new.balance_due is distinct from old.balance_due
    or new.commission is distinct from old.commission
    or new.commission_status is distinct from old.commission_status
    or new.payment_mode is distinct from old.payment_mode
    or new.reviews_unlocked is distinct from old.reviews_unlocked
    or new.job_id is distinct from old.job_id
    or new.customer_id is distinct from old.customer_id
    or new.hauler_id is distinct from old.hauler_id
    or new.hauler_done_at is distinct from old.hauler_done_at
    or new.customer_ack_at is distinct from old.customer_ack_at
    or new.admin_reviewed_at is distinct from old.admin_reviewed_at
    or new.admin_reviewed_by is distinct from old.admin_reviewed_by
    or new.coordination_deadline is distinct from old.coordination_deadline
    or new.coordination_extended_at is distinct from old.coordination_extended_at
    or new.stalled_at is distinct from old.stalled_at
    or new.locked_service_date is distinct from old.locked_service_date
    or new.locked_final_price is distinct from old.locked_final_price
    or new.locked_proposal_id is distinct from old.locked_proposal_id
    or new.authorize_at is distinct from old.authorize_at
    or new.authorized_at is distinct from old.authorized_at
    or new.captured_at is distinct from old.captured_at
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- ── 2b. payments gains a third kind: a simulated pre-capture hold ───────────────
alter table payments drop constraint payments_kind_check;
alter table payments add constraint payments_kind_check check (kind = any(array['charge', 'refund', 'authorization']));

-- ── 3. Notification event types ─────────────────────────────────────────────────
alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered',
  'bidRevisionProposed', 'bidRevisionResolved',
  'scheduleProposed', 'scheduleConfirmed', 'coordinationNudge', 'paymentAuthorized'
]));

-- ── 3b. profiles.notification_prefs default + backfill for the new event types ──
alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": true,
    "jobCompleted": true,
    "reminderOverdue": true,
    "jobBooked": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true
  },
  "smsEvents": {
    "newJobNearby": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true,
    "adminMessage": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  jsonb_set(
    notification_prefs,
    '{events}',
    coalesce(notification_prefs->'events', '{}'::jsonb) || '{"scheduleProposed": true, "scheduleConfirmed": true, "coordinationNudge": true, "paymentAuthorized": true}'::jsonb
  ),
  '{smsEvents}',
  coalesce(notification_prefs->'smsEvents', '{}'::jsonb) || '{"scheduleProposed": true, "scheduleConfirmed": true, "coordinationNudge": true, "paymentAuthorized": true}'::jsonb
);

-- ── 4. accept_bid(): full mode no longer charges anything at accept ────────────
-- Postgres won't let CREATE OR REPLACE change a function's output columns — needs a real
-- drop-and-recreate (same reason job_timeline.sql had to do this for list_open_jobs_for_hauler).
drop function if exists accept_bid(uuid, uuid);
create function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric, payment_mode text)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_chat_id uuid;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> auth.uid() then
    raise exception 'Only the job owner can accept a bid';
  end if;
  if v_job.status <> 'open' then
    raise exception 'Job is not open';
  end if;

  select * into v_bid from bids where id = p_bid_id and job_id = p_job_id for update;
  if v_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_bid.expires_at <= now() then
    raise exception 'This bid has expired and can no longer be accepted';
  end if;

  select * into v_pb from price_breakdown(v_bid.amount, v_job.payment_mode);

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    status = 'booked',
    accepted_bid_id = v_bid.id,
    accepted_at = now(),
    complete_by = now() + make_interval(days => app_config_numeric('completion_window_days')::int)
  where id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  insert into chats (
    job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode,
    coordination_deadline
  )
  values (
    p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_job.payment_mode,
    case when v_job.payment_mode = 'full' then now() + interval '48 hours' else null end
  )
  returning id into v_chat_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat_id, 'system',
    case when v_job.payment_mode = 'full'
      then format('Job locked in! No money has moved yet — propose a service date and final price in chat. Nothing is charged until 48 hours before the scheduled date, and only captured once the job is confirmed complete.')
      else format('Job locked in! $%s deposit paid to MyTrashBid. The remaining $%s is paid directly to your hauler at completion.', v_pb.deposit_now, v_pb.balance_due)
    end);

  -- Deposit mode still needs a pending payment row for create-deposit-intent to attach its
  -- PaymentIntent to; full mode has nothing to charge yet, so no row until authorization.
  if v_job.payment_mode <> 'full' then
    insert into payments (job_id, chat_id, amount, status)
    values (p_job_id, v_chat_id, v_pb.deposit_now, 'requires_payment');
  end if;

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_bid.hauler_id, 'bidAccepted', 'You won a job!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_job.customer_id, 'jobBooked', 'Your job is booked!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return query select v_chat_id, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_bid.amount, v_job.payment_mode;
end;
$$;
grant execute on function accept_bid(uuid, uuid) to authenticated;

-- ── 5. Shared "hold the funds" step — the one Stripe-authorize call gets wired here ──
-- Called from confirm_schedule() (rush jobs, where the service date is already <48h out at lock
-- time) and sync_full_payment_schedule() (the normal 48h-before sweep). Never called directly by
-- clients (revoked from public only, like finalize_completion — every legitimate caller is
-- another SECURITY DEFINER function already holding elevated rights).
create function perform_authorization(p_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
  v_job jobs%rowtype;
  v_notif_id uuid;
begin
  select * into v_chat from chats where id = p_chat_id for update;
  if v_chat.id is null or v_chat.authorized_at is not null then
    return;
  end if;
  select * into v_job from jobs where id = v_chat.job_id;

  insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
  values (v_chat.job_id, v_chat.id, v_chat.locked_final_price, 'succeeded', 'authorization', 'sim_auth_' || gen_random_uuid()::text);

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set authorized_at = now() where id = p_chat_id;

  insert into messages (chat_id, sender_role, text)
  values (p_chat_id, 'system', format('💳 $%s authorized and held by MyTrashBid ahead of your %s service — you''re only charged once the job is confirmed complete.',
    v_chat.locked_final_price, to_char(v_chat.locked_service_date, 'Mon DD')));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.customer_id, 'paymentAuthorized', 'Your payment method was authorized',
    format('$%s authorized for "%s" — charged only once the job is confirmed complete.', v_chat.locked_final_price, v_job.title),
    v_chat.job_id, p_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;
revoke execute on function perform_authorization(uuid) from public;

-- ── 6. Propose a service date + final price ─────────────────────────────────────
create function propose_schedule(p_job_id uuid, p_service_date date, p_final_price numeric)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_role text;
  v_other_party uuid;
  v_other_role text;
  v_proposal_id uuid;
  v_notif_id uuid;
  v_proposer_name text;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  if p_service_date < current_date then
    raise exception 'Service date can''t be in the past';
  end if;
  if p_final_price is null or p_final_price <= 0 then
    raise exception 'Enter a valid final price';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'booked' or v_job.completed then
    raise exception 'This job is not eligible for scheduling';
  end if;
  if v_job.payment_mode <> 'full' then
    raise exception 'Scheduling only applies to full-payment jobs';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null then
    raise exception 'No active chat for this job';
  end if;
  if v_chat.locked_service_date is not null then
    raise exception 'A service date is already locked in for this job';
  end if;
  if v_chat.hauler_done_at is not null then
    raise exception 'Work has already been marked complete on this job';
  end if;
  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before scheduling';
  end if;

  if v_chat.customer_id = auth.uid() then
    v_role := 'customer'; v_other_party := v_chat.hauler_id; v_other_role := 'hauler';
  elsif v_chat.hauler_id = auth.uid() then
    v_role := 'hauler'; v_other_party := v_chat.customer_id; v_other_role := 'customer';
  else
    raise exception 'Only the customer or hauler on this job can propose a service date';
  end if;

  -- Supersede any still-pending proposal on this chat — at most one live proposal at a time,
  -- same "the newer one wins" shape as bid_revisions' one-pending-at-a-time rule.
  update schedule_proposals set status = 'superseded' where chat_id = v_chat.id and status = 'pending';

  insert into schedule_proposals (job_id, chat_id, proposed_by, proposed_role, service_date, final_price)
  values (p_job_id, v_chat.id, auth.uid(), v_role, p_service_date, p_final_price)
  returning id into v_proposal_id;

  select coalesce(business_name, name) into v_proposer_name from profiles where id = auth.uid();

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('📅 %s proposed a service date: %s · Final price: $%s — the %s needs to confirm.',
    v_proposer_name, to_char(p_service_date, 'Mon DD, YYYY'), p_final_price, v_other_role));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_other_party, 'scheduleProposed', 'New service date proposed for "' || v_job.title || '"',
    format('%s · $%s — review and confirm in chat.', to_char(p_service_date, 'Mon DD, YYYY'), p_final_price), p_job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return v_proposal_id;
end;
$$;
revoke execute on function propose_schedule(uuid, date, numeric) from public;
grant execute on function propose_schedule(uuid, date, numeric) to authenticated;

-- ── 7. Confirm the other party's proposal — locks the date + price ─────────────
create function confirm_schedule(p_proposal_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_prop schedule_proposals%rowtype;
  v_chat chats%rowtype;
  v_job jobs%rowtype;
  v_authorize_at timestamptz;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_prop from schedule_proposals where id = p_proposal_id for update;
  if v_prop.id is null then
    raise exception 'Proposal not found';
  end if;
  if v_prop.status <> 'pending' then
    raise exception 'This proposal has already been resolved';
  end if;

  select * into v_chat from chats where id = v_prop.chat_id for update;
  if v_chat.id is null then
    raise exception 'Chat not found';
  end if;
  if v_chat.customer_id <> auth.uid() and v_chat.hauler_id <> auth.uid() then
    raise exception 'Only the customer or hauler on this job can confirm a service date';
  end if;
  if auth.uid() = v_prop.proposed_by then
    raise exception 'The other party needs to confirm this — you already proposed it';
  end if;

  update schedule_proposals set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now()
  where id = p_proposal_id;

  v_authorize_at := (v_prop.service_date::timestamp) - interval '48 hours';

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set
    locked_service_date = v_prop.service_date,
    locked_final_price = v_prop.final_price,
    locked_proposal_id = p_proposal_id,
    authorize_at = v_authorize_at,
    coordination_deadline = null,
    coordination_extended_at = null,
    stalled_at = null
  where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('✓ Service date locked: %s · Final price: $%s', to_char(v_prop.service_date, 'Mon DD, YYYY'), v_prop.final_price));

  select * into v_job from jobs where id = v_prop.job_id;
  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_prop.proposed_by, 'scheduleConfirmed', 'Service date confirmed for "' || v_job.title || '"',
    format('Locked: %s · $%s', to_char(v_prop.service_date, 'Mon DD, YYYY'), v_prop.final_price), v_prop.job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  -- Rush job — the service date was already inside the 48h authorization window at lock time.
  if v_authorize_at <= now() then
    perform perform_authorization(v_chat.id);
  end if;
end;
$$;
revoke execute on function confirm_schedule(uuid) from public;
grant execute on function confirm_schedule(uuid) to authenticated;

-- ── 8. Opportunistic sweep — coordination nudge/extend/stall + 48h-before authorization ──
-- No cron; called from the client whenever a hauler/customer job list loads (see
-- loadCustomerJobs/loadMyBidJobs in jobs/data.js), so the relevant state is always fresh by the
-- time either party next opens the job — exactly the "compute from timestamps on view load"
-- pattern the spec asks for, just with the one-time state transitions persisted so they don't
-- repeat (extend once, stall once, authorize once).
create function sync_full_payment_schedule() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_notif_id uuid;
begin
  if not is_active_user() then
    return;
  end if;

  perform set_config('app.bypass_chat_guard', 'true', true);

  -- FOR UPDATE serializes concurrent callers on the same rows — without it, two dashboards
  -- loading within the same instant (customer + hauler both opening the app, or React
  -- StrictMode's dev-mode double-invoke) can both read coordination_extended_at as still null
  -- and both apply the +48h extend, silently doubling the window to 96h. With the lock, the
  -- second caller blocks until the first commits, then re-reads the now-updated row and correctly
  -- takes the "already extended -> stall" branch instead (or skips it, if the first call already
  -- stalled it).
  for r in
    select id, coordination_extended_at from chats
    where payment_mode = 'full'
      and locked_service_date is null
      and stalled_at is null
      and coordination_deadline is not null
      and coordination_deadline <= now()
    for update
  loop
    if r.coordination_extended_at is null then
      update chats set coordination_deadline = coordination_deadline + interval '48 hours', coordination_extended_at = now()
      where id = r.id;
      insert into messages (chat_id, sender_role, text)
      values (r.id, 'system', 'You haven''t locked a service date yet — pick one to keep this job moving. This job now has another 48 hours before it''s flagged for review.');

      select * into v_chat from chats where id = r.id;
      select * into v_job from jobs where id = v_chat.job_id;

      insert into notifications (user_id, event_type, title, body, job_id, chat_id)
        values (v_chat.customer_id, 'coordinationNudge', 'Lock in a service date', v_job.title, v_chat.job_id, v_chat.id)
        returning id into v_notif_id;
      perform dispatch_notification_email(v_notif_id);
      perform dispatch_notification_sms(v_notif_id);

      insert into notifications (user_id, event_type, title, body, job_id, chat_id)
        values (v_chat.hauler_id, 'coordinationNudge', 'Lock in a service date', v_job.title, v_chat.job_id, v_chat.id)
        returning id into v_notif_id;
      perform dispatch_notification_email(v_notif_id);
      perform dispatch_notification_sms(v_notif_id);
    else
      update chats set stalled_at = now() where id = r.id;
      insert into messages (chat_id, sender_role, text)
      values (r.id, 'system', '🚩 This job has stalled without a locked service date and has been flagged for MyTrashBid review.');
      -- No notification here — matches cancellation_requests' precedent of surfacing to admin via
      -- the dashboard badge only, not a push.
    end if;
  end loop;

  for r in
    select id from chats
    where payment_mode = 'full'
      and locked_service_date is not null
      and authorized_at is null
      and captured_at is null
      and authorize_at <= now()
  loop
    perform perform_authorization(r.id);
  end loop;
end;
$$;
revoke execute on function sync_full_payment_schedule() from public;
grant execute on function sync_full_payment_schedule() to authenticated;

-- ── 9. Capture at completion ─────────────────────────────────────────────────────
-- Same PaymentIntent as the authorization (no new payments row — capturing doesn't create a new
-- Stripe object, it transitions the existing one) — captured_at is purely this app's own
-- bookkeeping timestamp for "the hold was finalized," layered on top of the existing
-- commission_status='earned' release that already happens for both payment modes.
create or replace function finalize_completion(p_chat chats, p_job jobs, p_auto boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_notif_id uuid;
begin
  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set
    customer_ack_at = now(), commission_status = 'earned', reviews_unlocked = true,
    captured_at = case when p_job.payment_mode = 'full' and authorized_at is not null and captured_at is null then now() else captured_at end
  where id = p_chat.id;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set completed = true, completed_at = now() where id = p_job.id;

  insert into messages (chat_id, sender_role, text)
  values (p_chat.id, 'system',
    case when p_auto
      then 'Job auto-acknowledged as complete after no response from the customer. Both sides can now leave a review.'
      else 'Customer acknowledged the job as complete. Both sides can now leave a review.'
    end);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (p_chat.hauler_id, 'jobCompleted', 'Job completed — leave a review', p_job.title, p_job.id, p_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
end;
$$;

-- ── 10. Broaden the admin refund view to cover pre-capture holds too ────────────
-- A cancellation after authorization but before capture has nothing to "refund" yet (no charge
-- was ever made) — it needs releasing instead. Reusing the same admin refund UI for both (per the
-- spec) means job_refundable_charges has to surface 'authorization' rows the same way it already
-- surfaces 'charge' rows; resolve_cancellation's insert already writes plain 'refund' rows against
-- whatever stripe_payment_intent_id it's given, for bookkeeping symmetry either way. `kind` is
-- now returned alongside the existing columns so process-cancellation-refund can tell the two
-- apart and call the right Stripe API: refunds.create() for a 'charge' (real money already moved),
-- vs paymentIntents.cancel()/a smaller capture() for an 'authorization' (nothing captured yet, so
-- there's no charge to refund against). Column set changed, so this needs a drop first — an
-- in-place CREATE OR REPLACE can't change a function's output columns.
drop function if exists job_refundable_charges(uuid);
create function job_refundable_charges(p_job_id uuid)
returns table (stripe_payment_intent_id text, charged numeric, refundable numeric, kind text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only admins can view refundable charges';
  end if;
  return query
    select
      c.stripe_payment_intent_id,
      c.amount as charged,
      c.amount - coalesce((
        select sum(r.amount) from payments r
        where r.kind = 'refund' and r.status = 'succeeded' and r.stripe_payment_intent_id = c.stripe_payment_intent_id
      ), 0) as refundable,
      c.kind
    from payments c
    where c.job_id = p_job_id and c.kind in ('charge', 'authorization') and c.status = 'succeeded'
    order by c.created_at asc;
end;
$$;
grant execute on function job_refundable_charges(uuid) to authenticated;
