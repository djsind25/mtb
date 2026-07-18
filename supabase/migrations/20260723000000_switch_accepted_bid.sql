-- MyTrashBid — Phase 2 of the payment rework: switch the accepted hauler (funds stay put)
--
-- Lets the customer reassign a booked job to a different bidder before work begins
-- (hauler_done_at is null). Held funds stay held and re-associate to the new hauler; only the
-- delta between the old and new bid amount is charged or refunded.
--
-- Privacy: chats is 1:1 with job_id today. Simply repointing chats.hauler_id would hand the new
-- hauler read access to the old hauler's entire private message history. Instead we relax the
-- uniqueness to "one *active* chat per job" (a partial unique index) so a job can accumulate
-- historical (superseded) chats — the old hauler keeps their (now read-only-in-practice, though
-- nothing technically blocks new messages) chat, the new hauler starts a clean thread and can
-- never see the old one, since chats_select is scoped to hauler_id = auth.uid().

alter table chats add column superseded_at timestamptz;
alter table chats drop constraint chats_job_id_key;
create unique index chats_job_id_active_key on chats (job_id) where superseded_at is null;

-- superseded_at joins the guard trigger's protected-field list — otherwise any customer/hauler
-- could set it directly via a plain table update (the trigger blocks changes by exclusion, so a
-- newly added column is wide open by default unless explicitly added here).
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
    or new.superseded_at is distinct from old.superseded_at
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- 'kind' disambiguates the accounting ledger once refunds exist alongside charges — Phase 3's
-- accounting (funds held / released / refunded) sums this instead of inferring from status.
-- Every existing row is a real charge, so the default backfills them correctly with no separate
-- update needed.
alter table payments add column kind text not null default 'charge' check (kind in ('charge', 'refund'));

-- A refund row records *which charge it refunded* by storing that charge's PaymentIntent id —
-- there's no separate PaymentIntent for a refund, so the plain uniqueness this column had before
-- (one row per PI, always true when every row was a charge) would collide the moment a refund
-- references its original charge's id. Scope uniqueness to charge rows only, where a real 1:1
-- with a distinct PaymentIntent still holds.
alter table payments drop constraint payments_stripe_payment_intent_id_key;
create unique index payments_stripe_payment_intent_id_charge_key on payments (stripe_payment_intent_id) where kind = 'charge';

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut'
]));

-- Read-only quote: given a candidate replacement bid, returns the price delta so the frontend can
-- show "this changes your total by $X" before the customer commits to anything. Callable directly
-- by the customer (auth.uid() checked internally) since it makes no writes.
--
-- Full-payment mode only: delta is computed as new_bid.amount - current_bid_amount, which is only
-- the same thing as "what MyTrashBid actually charged" when the full amount is what's held. In
-- deposit mode only 10% was ever collected (the 90% balance is paid hauler-direct, never touching
-- Stripe), so the same math would charge/refund the wrong amount — switching stays deposit-mode's
-- existing hauler-direct-balance behavior (i.e. unsupported here) rather than get that math wrong.
create function preview_bid_switch(p_job_id uuid, p_new_bid_id uuid)
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
  if v_job.payment_mode <> 'full' then
    raise exception 'Switching haulers is only available for jobs paid in full';
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
revoke execute on function preview_bid_switch(uuid, uuid) from public;
grant execute on function preview_bid_switch(uuid, uuid) to authenticated;

-- Does the actual swap: supersedes the old chat, opens a fresh one for the new hauler, repoints
-- accepted_bid_id, posts a system message on each side, and (when a delta actually moved money)
-- records it as a payments row. p_kind/p_amount/p_stripe_payment_intent_id describe money that
-- has *already* moved via Stripe by the time this is called — this function only books the
-- record, it never talks to Stripe itself (Postgres can't). That's exactly why it's service-role
-- only below: an ordinary authenticated caller could otherwise claim any charge/refund happened
-- without one actually occurring. p_customer_id is checked explicitly (not auth.uid(), which is
-- null under the service-role connection the edge function uses) — the edge function reads it
-- from the caller's verified JWT before ever reaching this call.
--
-- Refund targeting simplification (v1): if p_kind = 'refund', the edge function targets the most
-- recent successful charge on the job. Splitting a refund across multiple historical PaymentIntents
-- when a job has been switched more than once is Phase 3 territory (the admin-refund flow already
-- needs that logic for cancellations); here it's fine for a refund to simply fail with a clear
-- Stripe error in that rarer case rather than build the splitting logic twice.
create function finalize_bid_switch(
  p_job_id uuid, p_new_bid_id uuid, p_customer_id uuid,
  p_kind text default null, p_amount numeric default null, p_stripe_payment_intent_id text default null
)
returns table (chat_id uuid, delta numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_new_bid bids%rowtype;
  v_old_chat chats%rowtype;
  v_new_chat_id uuid;
  v_pb record;
  v_delta numeric;
  v_notif_id uuid;
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
  if v_job.payment_mode <> 'full' then
    raise exception 'Switching haulers is only available for jobs paid in full';
  end if;

  select * into v_old_chat from chats where job_id = p_job_id and superseded_at is null for update;
  if v_old_chat.id is null then
    raise exception 'No active chat for this job';
  end if;
  if v_old_chat.hauler_done_at is not null then
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

  v_delta := v_new_bid.amount - v_old_chat.bid_amount;
  select * into v_pb from price_breakdown(v_new_bid.amount, v_job.payment_mode);

  -- job_completion_photos is keyed by job_id, not chat_id, so without this a new hauler could
  -- inherit "before" photos the old hauler already uploaded (rows only ever exist pre-switch,
  -- since uploading requires hauler_owns_chat_job — same guard that blocks switching once
  -- hauler_done_at is set — so nothing legitimate is lost here).
  delete from job_completion_photos where job_id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set superseded_at = now() where id = v_old_chat.id;

  insert into chats (job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode)
  values (p_job_id, v_job.customer_id, v_new_bid.hauler_id, v_new_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_job.payment_mode)
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

  if p_kind is not null and p_amount is not null and p_amount <> 0 then
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
revoke execute on function finalize_bid_switch(uuid, uuid, uuid, text, numeric, text) from public;
grant execute on function finalize_bid_switch(uuid, uuid, uuid, text, numeric, text) to service_role;

-- Every one of these pre-dates switching and was written when "one chat per job" was a hard DB
-- constraint, so `where job_id = p_job_id` was always unambiguous. Now that a job can carry a
-- superseded (pre-switch) chat alongside its active one, each needs to say which one it means —
-- otherwise a bare job_id lookup can silently grab the wrong row (e.g. a hauler switched out
-- *before* ever marking done always has hauler_done_at null, so it can masquerade as "not done
-- yet" even after the *current* hauler genuinely marked the job complete).
create or replace function hauler_mark_done(p_job_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_before int;
  v_after int;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.hauler_id <> auth.uid() then
    raise exception 'Only the assigned hauler can mark this job complete';
  end if;
  if v_chat.hauler_done_at is not null then
    raise exception 'You have already marked this job complete';
  end if;

  select
    count(*) filter (where phase = 'before'),
    count(*) filter (where phase = 'after')
  into v_before, v_after
  from job_completion_photos where job_id = p_job_id;
  if v_before < 1 or v_after < 1 then
    raise exception 'Upload at least one before photo and one after photo before marking complete';
  end if;

  select * into v_job from jobs where id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set hauler_done_at = now() where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system',
    'Hauler marked the work complete and uploaded before/after photos. Please review and acknowledge completion.');

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (v_chat.customer_id, 'jobMarkedDone', 'Your hauler marked the job complete', v_job.title, p_job_id, v_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;

create or replace function customer_acknowledge_completion(p_job_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.customer_id <> auth.uid() then
    raise exception 'Only the customer can acknowledge this job';
  end if;
  if v_chat.hauler_done_at is null then
    raise exception 'The hauler has not marked this job complete yet';
  end if;
  if v_chat.customer_ack_at is not null then
    raise exception 'You have already acknowledged this job';
  end if;

  select * into v_job from jobs where id = p_job_id;
  perform finalize_completion(v_chat, v_job, false);
end;
$$;

create or replace function admin_review_completion(p_job_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can review completions';
  end if;
  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.hauler_done_at is null then
    raise exception 'This job has not been marked complete';
  end if;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set admin_reviewed_at = now(), admin_reviewed_by = auth.uid() where id = v_chat.id;
end;
$$;

-- Unfiltered, this join could match a job's superseded chat as well as its active one, sending
-- the reminder to a hauler who no longer holds the job (or doubling it up for the current one).
create or replace function send_overdue_reminders() returns void
  language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_notif_id uuid;
begin
  perform set_config('app.bypass_job_guard', 'true', true);
  for r in
    select j.id as job_id, j.title, c.id as chat_id, c.hauler_id, c.customer_id
    from jobs j join chats c on c.job_id = j.id and c.superseded_at is null
    where j.status = 'booked' and not j.completed and j.complete_by < now() and not j.overdue_notified
  loop
    insert into notifications (user_id, event_type, title, body, job_id, chat_id)
      values (r.hauler_id, 'reminderOverdue', 'Please confirm job completion', r.title, r.job_id, r.chat_id)
      returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
    update jobs set overdue_notified = true where id = r.job_id;
  end loop;
end;
$$;

-- Looked up by the edge function before calling Stripe: the most recent successful charge on the
-- job is the refund target for a delta < 0 switch (see the refund-targeting note above).
create function latest_job_charge(p_job_id uuid)
returns table (stripe_payment_intent_id text, amount numeric)
language sql stable security definer set search_path = public as $$
  select stripe_payment_intent_id, amount from payments
  where job_id = p_job_id and kind = 'charge' and status = 'succeeded'
  order by created_at desc limit 1;
$$;
revoke execute on function latest_job_charge(uuid) from public;
grant execute on function latest_job_charge(uuid) to service_role;
