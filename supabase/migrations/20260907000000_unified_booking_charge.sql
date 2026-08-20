-- Stripe Connect Express payment rework — Phase 2: checkout/charge.
--
-- Replaces the deposit/full payment_mode split with one flow: the customer is charged the full
-- bid amount plus a separate service fee, immediately and for real, at bid acceptance. That money
-- is captured into the platform's own Stripe balance (a plain PaymentIntent, not a destination
-- charge) and held there until a later migration's release step transfers the hauler's share to
-- their Connect account.
--
-- Deliberately NOT renaming jobs.status/payments.status or dropping deposit/balance_due/
-- locked_final_price/authorize_at/authorized_at — none of that is required to charge for real,
-- and removing it would touch dozens of call sites across both the SQL and frontend for no
-- functional gain. Every job already defaults to payment_mode='full' (app_config.
-- default_payment_mode), so this migration's real job is: make the 'full' charging path actually
-- charge (today it charges nothing until a simulated authorize/capture at completion), and stop
-- the deposit-mode 90/10 split from being reachable at all. price_breakdown() is reused unchanged
-- by always calling it with p_payment_mode := 'full' — that already produces deposit_now = full
-- amount, balance_due = 0, exactly this new model's shape.
--
-- One real functional change beyond charging: propose_schedule()/confirm_schedule() used to let
-- either party freely renegotiate a "final price" ahead of the old pre-payment authorization
-- window — safe back when nothing had been charged yet. Now that the full amount is charged at
-- acceptance, a differing final_price would be pure fiction with no connection to real money.
-- propose_schedule() no longer accepts a price at all — it's a date-only confirmation, matching
-- the approved plan's decision to keep scheduling as a logistics step with no payment tied to it.
-- perform_authorization() (the simulated, non-Stripe authorize step) is dropped outright: nothing
-- calls it anymore, and leaving it in place would be a footgun.

-- ─── 1. chats — new columns for the unified charge ─────────────────────────────────────────────

alter table chats add column service_fee numeric(10,2) not null default 0;
alter table chats add column transfer_group text;

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
    or new.commission_rate is distinct from old.commission_rate
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
    or new.support_status is distinct from old.support_status
    or new.admin_locked_at is distinct from old.admin_locked_at
    or new.admin_locked_by is distinct from old.admin_locked_by
    or new.assigned_admin_id is distinct from old.assigned_admin_id
    or new.service_fee is distinct from old.service_fee
    or new.transfer_group is distinct from old.transfer_group
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- ─── 2. accept_bid() — always charges bid_amount + service_fee in full, immediately. Adds a
--    service_fee output column, so DROP+CREATE is required. ────────────────────────────────────

drop function if exists accept_bid(uuid, uuid);

create function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric, payment_mode text, service_fee numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_rate numeric;
  v_service_fee numeric;
  v_connect_ok boolean;
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

  -- Re-check the hauler's Stripe Connect status at acceptance time, not just at bid-submission
  -- time (bids_enforce_connect_onboarded only guards insert) — a bid can sit for days, and Stripe
  -- can restrict a previously-enabled account in the interim.
  select stripe_connect_charges_enabled and stripe_connect_payouts_enabled into v_connect_ok
    from profiles where id = v_bid.hauler_id;
  if not coalesce(v_connect_ok, false) then
    raise exception 'CONNECT_ONBOARDING_REQUIRED: This hauler''s payout account is no longer active. They must complete Stripe onboarding again before this bid can be accepted.';
  end if;

  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_bid.hauler_id;
  -- Always priced as a full up-front charge — price_breakdown('full', ...) already produces
  -- deposit_now = full amount, balance_due = 0, exactly this model's shape, so it's reused as-is
  -- rather than adding a parallel code path.
  select * into v_pb from price_breakdown(v_bid.amount, 'full', v_rate);
  select round(v_bid.amount * (select service_fee_rate from platform_fee_config where id = true), 2) into v_service_fee;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    status = 'booked',
    accepted_bid_id = v_bid.id,
    accepted_at = now(),
    complete_by = now() + make_interval(days => app_config_numeric('completion_window_days')::int)
  where id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  insert into chats (
    job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode,
    service_fee, transfer_group, coordination_deadline
  )
  values (
    p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_rate, v_job.payment_mode,
    v_service_fee, 'job_' || p_job_id::text, now() + interval '48 hours'
  )
  returning id into v_chat_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat_id, 'system', format(
    'Job locked in! $%s (bid $%s + $%s service fee) is held securely by MyTrashBid and released to your hauler once the job is confirmed complete.',
    v_pb.deposit_now + v_service_fee, v_pb.deposit_now, v_service_fee));

  insert into payments (job_id, chat_id, amount, status)
  values (p_job_id, v_chat_id, v_pb.deposit_now + v_service_fee, 'requires_payment');

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

  return query select v_chat_id, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_bid.amount, v_job.payment_mode, v_service_fee;
end;
$$;
revoke all on function accept_bid(uuid, uuid) from public;
grant all on function accept_bid(uuid, uuid) to authenticated;

-- ─── 3. switch-hauler flow — was gated to payment_mode='full' jobs only; now unconditional since
--    every job charges the same way. Also computes service_fee/transfer_group for the new chat
--    row so a switched-to hauler's payout math stays correct in later phases. ───────────────────

create or replace function preview_bid_switch(p_job_id uuid, p_new_bid_id uuid)
returns table (current_bid_amount numeric, new_bid_amount numeric, delta numeric, current_chat_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_new_bid bids%rowtype;
  v_chat chats%rowtype;
begin
  select * into v_job from jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> auth.uid() then
    raise exception 'Only the job owner can switch haulers';
  end if;
  if v_job.status <> 'booked' then
    raise exception 'Job is not booked';
  end if;
  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before switching haulers';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null then
    raise exception 'No active chat for this job';
  end if;
  if v_chat.hauler_done_at is not null then
    raise exception 'Work has already been marked complete on this job and the hauler can no longer be switched';
  end if;

  select * into v_new_bid from bids where id = p_new_bid_id and job_id = p_job_id;
  if v_new_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_new_bid.id = v_job.accepted_bid_id then
    raise exception 'This hauler is already assigned to the job';
  end if;
  if v_new_bid.expires_at <= now() then
    raise exception 'This bid has expired and can no longer be selected';
  end if;

  return query select v_chat.bid_amount, v_new_bid.amount, (v_new_bid.amount - v_chat.bid_amount), v_chat.id;
end;
$$;

create or replace function finalize_bid_switch(
  p_job_id uuid, p_new_bid_id uuid, p_customer_id uuid,
  p_kind text default null, p_amount numeric default null, p_stripe_payment_intent_id text default null,
  p_refunds jsonb default null
) returns table(chat_id uuid, delta numeric)
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_new_bid bids%rowtype;
  v_old_chat chats%rowtype;
  v_new_chat_id uuid;
  v_pb record;
  v_rate numeric;
  v_service_fee numeric;
  v_delta numeric;
  v_notif_id uuid;
  v_refund jsonb;
begin
  if p_kind is not null and p_kind not in ('charge', 'refund') then
    raise exception 'Invalid payment kind';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> p_customer_id then
    raise exception 'Only the job owner can switch haulers';
  end if;
  if v_job.status <> 'booked' then
    raise exception 'Job is not booked';
  end if;
  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before switching haulers';
  end if;

  select * into v_old_chat from chats where job_id = p_job_id and superseded_at is null for update;
  if v_old_chat.id is null then
    raise exception 'No active chat for this job';
  end if;
  if v_old_chat.hauler_done_at is not null then
    raise exception 'Work has already been marked complete on this job and the hauler can no longer be switched';
  end if;
  -- Note: a defensive "already paid out" check is added here by the Phase 3 migration once the
  -- payouts table exists (money that already left the platform balance can't be undone by a plain
  -- refund) — hauler_done_at above already covers every reachable case today, since a payout can
  -- only ever be created after hauler_done_at is set.

  select * into v_new_bid from bids where id = p_new_bid_id and job_id = p_job_id;
  if v_new_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_new_bid.id = v_job.accepted_bid_id then
    raise exception 'This hauler is already assigned to the job';
  end if;
  if v_new_bid.expires_at <= now() then
    raise exception 'This bid has expired and can no longer be selected';
  end if;

  v_delta := v_new_bid.amount - v_old_chat.bid_amount;
  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_new_bid.hauler_id;
  select * into v_pb from price_breakdown(v_new_bid.amount, 'full', v_rate);
  select round(v_new_bid.amount * (select service_fee_rate from platform_fee_config where id = true), 2) into v_service_fee;

  delete from job_completion_photos where job_id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set superseded_at = now() where id = v_old_chat.id;

  insert into chats (job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode, service_fee, transfer_group)
  values (p_job_id, v_job.customer_id, v_new_bid.hauler_id, v_new_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_rate, v_job.payment_mode, v_service_fee, v_old_chat.transfer_group)
  returning id into v_new_chat_id;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set accepted_bid_id = p_new_bid_id where id = p_job_id;

  insert into messages (chat_id, sender_role, text)
  values (v_old_chat.id, 'system', 'The customer switched to another hauler for this job.');

  insert into messages (chat_id, sender_role, text)
  values (v_new_chat_id, 'system',
    case when v_delta > 0 then format('You''ve been assigned this job after the customer switched haulers! Bid: $%s (an additional $%s was charged to cover the difference).', v_new_bid.amount, v_delta)
      when v_delta < 0 then format('You''ve been assigned this job after the customer switched haulers! Bid: $%s ($%s of the difference was refunded to the customer).', v_new_bid.amount, abs(v_delta))
      else format('You''ve been assigned this job after the customer switched haulers! Bid: $%s (no change to the amount already held).', v_new_bid.amount)
    end);

  if p_refunds is not null then
    for v_refund in select * from jsonb_array_elements(p_refunds)
    loop
      insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
      values (p_job_id, v_new_chat_id, (v_refund->>'amount')::numeric, 'succeeded', 'refund', v_refund->>'stripe_payment_intent_id');
    end loop;
  elsif p_kind is not null and p_amount is not null and p_amount <> 0 then
    insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
    values (p_job_id, v_new_chat_id, abs(p_amount), 'succeeded', p_kind, p_stripe_payment_intent_id);
  end if;

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_old_chat.hauler_id, 'bidSwitchedOut', 'Customer switched to another hauler', v_job.title, p_job_id, v_old_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_new_bid.hauler_id, 'bidAccepted', 'You won a job!', v_job.title, p_job_id, v_new_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return query select v_new_chat_id, v_delta;
end;
$$;

-- ─── 4. Scheduling becomes date-only. propose_schedule() drops its price parameter entirely
--    (DROP+CREATE, parameter list changes); it echoes the chat's real charged bid_amount into
--    final_price instead, so confirm_schedule()'s existing message/locked_final_price handling
--    needs no changes and never displays a number that disagrees with what was actually charged.

drop function if exists propose_schedule(uuid, date, numeric);

create function propose_schedule(p_job_id uuid, p_service_date date)
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

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'booked' or v_job.completed then
    raise exception 'This job is not eligible for scheduling';
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

  -- Supersede any still-pending proposal on this chat — at most one live proposal at a time.
  update schedule_proposals set status = 'superseded' where chat_id = v_chat.id and status = 'pending';

  -- final_price is no longer caller-supplied — it's always the amount actually charged at
  -- acceptance, so this table's existing column keeps working (confirm_schedule and admin
  -- reporting both already fall back to it) without ever disagreeing with real money moved.
  insert into schedule_proposals (job_id, chat_id, proposed_by, proposed_role, service_date, final_price)
  values (p_job_id, v_chat.id, auth.uid(), v_role, p_service_date, v_chat.bid_amount)
  returning id into v_proposal_id;

  select coalesce(business_name, name) into v_proposer_name from profiles where id = auth.uid();

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('📅 %s proposed a service date: %s — the %s needs to confirm.',
    v_proposer_name, to_char(p_service_date, 'Mon DD, YYYY'), v_other_role));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_other_party, 'scheduleProposed', 'New service date proposed for "' || v_job.title || '"',
    format('%s — review and confirm in chat.', to_char(p_service_date, 'Mon DD, YYYY')), p_job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return v_proposal_id;
end;
$$;
revoke all on function propose_schedule(uuid, date) from public;
grant execute on function propose_schedule(uuid, date) to authenticated;

-- confirm_schedule(): drop the authorize_at computation and the perform_authorization() call —
-- payment already happened at acceptance, so there's nothing left to authorize near the service
-- date. The date-lock/message/notification behavior is otherwise unchanged.
create or replace function confirm_schedule(p_proposal_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_prop schedule_proposals%rowtype;
  v_chat chats%rowtype;
  v_job jobs%rowtype;
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

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set
    locked_service_date = v_prop.service_date,
    locked_final_price = v_prop.final_price,
    locked_proposal_id = p_proposal_id,
    coordination_deadline = null,
    coordination_extended_at = null,
    stalled_at = null
  where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('✓ Service date locked: %s', to_char(v_prop.service_date, 'Mon DD, YYYY')));

  select * into v_job from jobs where id = v_prop.job_id;
  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_prop.proposed_by, 'scheduleConfirmed', 'Service date confirmed for "' || v_job.title || '"',
    to_char(v_prop.service_date, 'Mon DD, YYYY'), v_prop.job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;

-- sync_full_payment_schedule(): drop the authorize-triggering loop — nothing is left to authorize
-- once payment happens at acceptance. The coordination-deadline/stall nudge loop (unrelated to
-- payment timing, just a "pick a date" reminder) is unchanged.
create or replace function sync_full_payment_schedule() returns void
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
    end if;
  end loop;
end;
$$;

-- perform_authorization() is now unreachable (its only two call sites, above, are gone) — dropped
-- outright rather than left orphaned, so nobody can accidentally call it and insert a phantom
-- duplicate charge row for money already collected at acceptance.
drop function if exists perform_authorization(uuid);
