-- MyTrashBid — hauler-side discount codes on the platform fee.
--
-- A discount code reduces the PLATFORM FEE the hauler pays on one completed job — it never touches
-- the customer's price. The hauler redeems a code from their own account settings; it sits pending
-- (not tied to any job) until they next win a bid, at which point it's stamped onto that job's
-- commission rate the same way a membership-tier rate already is. It's only truly consumed once
-- that job reaches completion; if the job is cancelled or the hauler is switched out first, the
-- code is restored to pending for a future job.
--
-- ── Where this hooks in, and why (read this before touching accept_bid/finalize_completion/
--    resolve_cancellation again) ──────────────────────────────────────────────────────────────────
-- The platform fee rate is frozen at ACCEPTANCE, not at completion — accept_bid() computes
-- membership_commission_rate(tier) and stamps it onto chats.commission_rate/commission the moment
-- a bid is accepted (see 20260907000000_unified_booking_charge.sql). Completion
-- (finalize_completion) only flips commission_status to 'earned' and creates the payout — it never
-- recomputes the rate. So the discount has to be APPLIED at accept_bid time (and in
-- finalize_bid_switch, the other place a rate gets frozen), while CONSUMPTION (the redemption-
-- history entry, clearing the hauler's pending code) happens at finalize_completion, and RESTORATION
-- (undoing the stamp, giving the code back) happens wherever a booked job ends without completing —
-- resolve_cancellation, and the old-chat side of finalize_bid_switch.
--
-- chats.applied_discount_code_id is the join between "what got stamped on this job" and "what needs
-- restoring/consuming later" — hauler_discount_pending.applied_chat_id is the inverse pointer, used
-- to reserve a pending code to at most one in-flight job at a time (a hauler can still win a second
-- job while the first is in flight; the code just isn't available to a second job until the first
-- either consumes or releases it).

-- ─── 1. discount_codes — admin-created, generic enough for a future flat-rate type ────────────────

create table discount_codes (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  discount_type      text not null default 'points_off_fee' check (discount_type in ('points_off_fee')),
  discount_value     numeric(5,2) not null check (discount_value > 0),
  active             boolean not null default true,
  expires_at         timestamptz,
  max_redemptions    int check (max_redemptions is null or max_redemptions > 0),
  created_by         uuid references profiles(id),
  created_at         timestamptz not null default now()
);
alter table discount_codes enable row level security;
grant select on discount_codes to authenticated;
-- Policy created further down, once hauler_discount_pending/discount_redemptions exist — a hauler
-- needs to read the display fields (code, discount_value) of a code they actually have some
-- connection to, not just admins. See that policy's own comment for why.

-- ─── 2. hauler_discount_pending — at most one pending code per hauler (PK is the enforcement).
--    applied_chat_id is null = available to the next accepted bid; non-null = already reserved to
--    that in-flight job, waiting on it to complete (consume) or fall through (restore). ───────────

create table hauler_discount_pending (
  hauler_id         uuid primary key references profiles(id),
  discount_code_id  uuid not null references discount_codes(id),
  -- deferrable: accept_bid()/finalize_bid_switch() generate the chat id up front and reserve it
  -- here *before* the chats row itself is inserted later in the same transaction — a same-
  -- transaction forward reference, resolved by checking this FK at commit instead of immediately.
  applied_chat_id   uuid references chats(id) deferrable initially deferred,
  created_at        timestamptz not null default now()
);
alter table hauler_discount_pending enable row level security;
create policy hauler_discount_pending_select on hauler_discount_pending for select using (hauler_id = auth.uid() or is_admin());
grant select on hauler_discount_pending to authenticated;
-- No insert/update/delete grant — every write goes through the RPCs below.

-- ─── 3. discount_redemptions — append-only, kept forever even after the code itself is fully
--    consumed (this table IS the "used" record; there's nothing left in hauler_discount_pending to
--    mark as used, since consumption deletes that row outright). ───────────────────────────────────

create table discount_redemptions (
  id                 uuid primary key default gen_random_uuid(),
  hauler_id          uuid not null references profiles(id),
  discount_code_id   uuid not null references discount_codes(id),
  job_id             uuid not null references jobs(id),
  chat_id            uuid not null references chats(id),
  original_rate      numeric(5,4) not null,
  discounted_rate    numeric(5,4) not null,
  amount_saved       numeric(10,2) not null,
  created_at         timestamptz not null default now()
);
create index discount_redemptions_code_id_idx on discount_redemptions (discount_code_id);
create index discount_redemptions_hauler_id_idx on discount_redemptions (hauler_id);
alter table discount_redemptions enable row level security;
create policy discount_redemptions_select on discount_redemptions for select using (hauler_id = auth.uid() or is_admin());
grant select on discount_redemptions to authenticated;
-- No insert/update/delete grant — written exclusively by consume_hauler_discount_for_chat() below.

-- A hauler needs to read the code string + discount value of a code they have some real connection
-- to (currently pending, or in their own redemption history) so the account-settings UI can show
-- "Code SAVE3, 3 points off" instead of a bare id — PostgREST's embedded-relationship selects (see
-- loadMyPendingDiscount()/loadMyDiscountHistory() in dashboard/data.js) evaluate the embedded
-- table's OWN RLS independently of the outer query, so admin-only here would silently null out the
-- embed for every non-admin caller rather than erroring.
create policy discount_codes_select on discount_codes for select using (
  is_admin()
  or exists (select 1 from hauler_discount_pending hdp where hdp.discount_code_id = discount_codes.id and hdp.hauler_id = auth.uid())
  or exists (select 1 from discount_redemptions dr where dr.discount_code_id = discount_codes.id and dr.hauler_id = auth.uid())
);

-- ─── 4. chats — stamp which code (if any) applied to this specific job, so cancellation/switch can
--    find it again to restore. Added to the self-update guard like every other money column. ──────

alter table chats add column applied_discount_code_id uuid references discount_codes(id);

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
    or new.applied_discount_code_id is distinct from old.applied_discount_code_id
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- ─── 5. Shared helpers — apply / restore / consume. Called from accept_bid, finalize_bid_switch,
--    finalize_completion, and resolve_cancellation so the logic lives in exactly one place. ────────

-- Returns the (possibly discounted) rate and stamps the pending code as reserved to p_chat_id if one
-- was available. Callers must generate the chat id up front (gen_random_uuid()) and pass it in,
-- rather than relying on `returning id` after the insert, so the reservation can happen before or
-- alongside the chat row landing.
create function apply_hauler_discount(p_hauler_id uuid, p_base_rate numeric, p_chat_id uuid)
returns table (rate numeric, code_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_pending hauler_discount_pending%rowtype;
  v_code discount_codes%rowtype;
  v_rate numeric;
begin
  select * into v_pending from hauler_discount_pending
    where hauler_id = p_hauler_id and applied_chat_id is null for update;
  if v_pending.hauler_id is null then
    -- `return query` appends to the result set but does NOT exit the function — without this bare
    -- return, execution falls through into the apply path below with v_pending/v_code all-null,
    -- unconditionally overwriting applied_chat_id on whatever row this hauler_id matches (real bug,
    -- caught live: a second job's accept_bid silently stole the reservation from the first).
    return query select p_base_rate, null::uuid;
    return;
  end if;

  select * into v_code from discount_codes where id = v_pending.discount_code_id;
  v_rate := greatest(p_base_rate - (v_code.discount_value / 100.0), 0);

  update hauler_discount_pending set applied_chat_id = p_chat_id where hauler_id = p_hauler_id;

  return query select v_rate, v_code.id;
end;
$$;

-- Undoes the reservation on a chat that fell through before completion (cancelled, or the hauler
-- was switched out) — gives the code back to pending, available for a future job. A no-op if the
-- chat never had a discount stamped on it.
create function restore_hauler_discount_for_chat(p_chat_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  update hauler_discount_pending set applied_chat_id = null where applied_chat_id = p_chat_id;
end;
$$;

-- Truly consumes a stamped discount at completion: writes the permanent redemption-history row,
-- then deletes the pending row outright (one-time use, gone). A no-op if this chat never had a
-- discount stamped on it. original_rate is recomputed from the hauler's current membership tier
-- rather than stored redundantly — it's what they would have paid without the code, which is the
-- correct comparison even if their tier changed between acceptance and completion.
create function consume_hauler_discount_for_chat(p_chat chats) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_original_rate numeric;
  v_amount_saved numeric;
begin
  if p_chat.applied_discount_code_id is null then
    return;
  end if;

  select membership_commission_rate(pr.membership_tier) into v_original_rate
    from profiles pr where pr.id = p_chat.hauler_id;
  v_amount_saved := round(p_chat.bid_amount * (v_original_rate - p_chat.commission_rate), 2);

  insert into discount_redemptions (hauler_id, discount_code_id, job_id, chat_id, original_rate, discounted_rate, amount_saved)
  values (p_chat.hauler_id, p_chat.applied_discount_code_id, p_chat.job_id, p_chat.id, v_original_rate, p_chat.commission_rate, v_amount_saved);

  delete from hauler_discount_pending where hauler_id = p_chat.hauler_id and applied_chat_id = p_chat.id;
end;
$$;

-- ─── 6. accept_bid() — apply a pending discount (if any) to the frozen rate. Same output signature
--    as before, so CREATE OR REPLACE suffices this time (no DROP needed). ───────────────────────────

create or replace function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric, payment_mode text, service_fee numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_rate numeric;
  v_disc record;
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

  select stripe_connect_charges_enabled and stripe_connect_payouts_enabled into v_connect_ok
    from profiles where id = v_bid.hauler_id;
  if not coalesce(v_connect_ok, false) then
    raise exception 'CONNECT_ONBOARDING_REQUIRED: This hauler''s payout account is no longer active. They must complete Stripe onboarding again before this bid can be accepted.';
  end if;

  v_chat_id := gen_random_uuid();
  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_bid.hauler_id;
  select * into v_disc from apply_hauler_discount(v_bid.hauler_id, v_rate, v_chat_id);

  select * into v_pb from price_breakdown(v_bid.amount, 'full', v_disc.rate);
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
    id, job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode,
    service_fee, transfer_group, coordination_deadline, applied_discount_code_id
  )
  values (
    v_chat_id, p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_disc.rate, v_job.payment_mode,
    v_service_fee, 'job_' || p_job_id::text, now() + interval '48 hours', v_disc.code_id
  );

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

-- ─── 7. finalize_bid_switch() — restore the old hauler's discount (if any), apply the new hauler's
--    pending discount (if any) to the fresh rate. Same output signature — CREATE OR REPLACE. ───────

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
  v_disc record;
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
  if exists (select 1 from payouts where chat_id = v_old_chat.id and status = 'paid') then
    raise exception 'This hauler has already been paid out for this job and can no longer be switched';
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
  v_new_chat_id := gen_random_uuid();

  -- The outgoing hauler's discount (if any) wasn't earned — this job never reached completion under
  -- them — so it goes back to pending for a future job. Independent of applying a discount to the
  -- new chat below: bids has a unique (job_id, hauler_id) constraint, so the new hauler is always a
  -- genuinely different account from the old one here, and the two operations touch different rows.
  perform restore_hauler_discount_for_chat(v_old_chat.id);

  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_new_bid.hauler_id;
  select * into v_disc from apply_hauler_discount(v_new_bid.hauler_id, v_rate, v_new_chat_id);
  select * into v_pb from price_breakdown(v_new_bid.amount, 'full', v_disc.rate);
  select round(v_new_bid.amount * (select service_fee_rate from platform_fee_config where id = true), 2) into v_service_fee;

  delete from job_completion_photos where job_id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set superseded_at = now() where id = v_old_chat.id;

  insert into chats (
    id, job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode,
    service_fee, transfer_group, applied_discount_code_id
  )
  values (
    v_new_chat_id, p_job_id, v_job.customer_id, v_new_bid.hauler_id, v_new_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_disc.rate, v_job.payment_mode,
    v_service_fee, v_old_chat.transfer_group, v_disc.code_id
  );

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

-- ─── 8. finalize_completion() — consume the discount (if any) right alongside the existing
--    bookkeeping. ─────────────────────────────────────────────────────────────────────────────────

create or replace function finalize_completion(p_chat chats, p_job jobs, p_auto boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_notif_id uuid;
  v_payout_id uuid;
  v_payment_id uuid;
  v_connect_account_id text;
begin
  perform consume_hauler_discount_for_chat(p_chat);

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

  select id into v_payment_id from payments
  where job_id = p_job.id and kind = 'charge' and status = 'succeeded'
  order by created_at desc limit 1;

  select stripe_connect_account_id into v_connect_account_id from profiles where id = p_chat.hauler_id;

  insert into payouts (job_id, chat_id, payment_id, hauler_id, stripe_connect_account_id, amount, status)
  values (p_job.id, p_chat.id, v_payment_id, p_chat.hauler_id, v_connect_account_id, p_chat.bid_amount - p_chat.commission, 'pending')
  returning id into v_payout_id;

  perform dispatch_payout_release(v_payout_id);
end;
$$;

-- ─── 9. resolve_cancellation() — restore the discount (if any) since this job never completed. ─────

create or replace function resolve_cancellation(p_request_id uuid, p_refund_amount numeric, p_retained_amount numeric, p_refunds jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req cancellation_requests%rowtype;
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_refund jsonb;
  v_notif_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve cancellation requests';
  end if;

  select * into v_req from cancellation_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Cancellation request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been resolved';
  end if;

  select * into v_job from jobs where id = v_req.job_id for update;
  select * into v_chat from chats where id = v_req.chat_id;

  perform restore_hauler_discount_for_chat(v_req.chat_id);

  for v_refund in select * from jsonb_array_elements(p_refunds)
  loop
    insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
    values (v_req.job_id, v_req.chat_id, (v_refund->>'amount')::numeric, 'succeeded', 'refund', v_refund->>'stripe_payment_intent_id');
  end loop;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set status = 'cancelled' where id = v_req.job_id;

  update cancellation_requests set
    status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
    refund_amount = p_refund_amount, retained_amount = p_retained_amount
  where id = p_request_id;

  insert into messages (chat_id, sender_role, text)
  values (v_req.chat_id, 'system', format('This job was cancelled by MyTrashBid. $%s was refunded to the customer.%s',
    p_refund_amount, case when p_retained_amount > 0 then format(' $%s was retained.', p_retained_amount) else '' end));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.customer_id, 'jobCancelled', 'Job cancelled', v_job.title, v_req.job_id, v_req.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.hauler_id, 'jobCancelled', 'Job cancelled', v_job.title, v_req.job_id, v_req.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;

-- ─── 10. Hauler-facing RPCs ──────────────────────────────────────────────────────────────────────

create function redeem_hauler_discount_code(p_code text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_code discount_codes%rowtype;
  v_redemption_count int;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  if not exists (select 1 from profiles where id = auth.uid() and role = 'hauler') then
    raise exception 'Only hauler accounts can redeem a discount code';
  end if;

  select * into v_code from discount_codes where upper(code) = upper(trim(p_code));
  if v_code.id is null then
    raise exception 'That code isn''t valid.';
  end if;
  if not v_code.active then
    raise exception 'That code is no longer active.';
  end if;
  if v_code.expires_at is not null and v_code.expires_at < now() then
    raise exception 'That code has expired.';
  end if;

  if v_code.max_redemptions is not null then
    select count(*) into v_redemption_count from discount_redemptions where discount_code_id = v_code.id;
    if v_redemption_count >= v_code.max_redemptions then
      raise exception 'That code has reached its redemption limit.';
    end if;
  end if;

  if exists (select 1 from hauler_discount_pending where hauler_id = auth.uid()) then
    raise exception 'You already have a discount code pending — it must be used or you can wait for it to apply before redeeming another.';
  end if;

  insert into hauler_discount_pending (hauler_id, discount_code_id) values (auth.uid(), v_code.id);
end;
$$;
revoke execute on function redeem_hauler_discount_code(text) from public;
grant execute on function redeem_hauler_discount_code(text) to authenticated;

-- ─── 11. Admin RPCs ──────────────────────────────────────────────────────────────────────────────

create function admin_create_discount_code(
  p_code text, p_discount_value numeric, p_expires_at timestamptz default null, p_max_redemptions int default null,
  p_client_user_agent text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can create a discount code.';
  end if;
  perform require_aal2();
  if p_code is null or trim(p_code) = '' then
    raise exception 'A code string is required.';
  end if;
  if p_discount_value <= 0 then
    raise exception 'Discount value must be greater than zero.';
  end if;

  insert into discount_codes (code, discount_value, expires_at, max_redemptions, created_by)
  values (upper(trim(p_code)), p_discount_value, p_expires_at, p_max_redemptions, auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function admin_create_discount_code(text, numeric, timestamptz, int, text) from public;
grant execute on function admin_create_discount_code(text, numeric, timestamptz, int, text) to authenticated;

create function admin_set_discount_code_active(p_code_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can change a discount code.';
  end if;
  perform require_aal2();

  update discount_codes set active = p_active where id = p_code_id;
  if not found then
    raise exception 'Discount code not found';
  end if;
end;
$$;
revoke execute on function admin_set_discount_code_active(uuid, boolean) from public;
grant execute on function admin_set_discount_code_active(uuid, boolean) to authenticated;

-- List every code with its redemption stats folded in — one round trip for the admin table.
create function admin_list_discount_codes()
returns table (
  id uuid, code text, discount_value numeric, active boolean, expires_at timestamptz, max_redemptions int,
  created_at timestamptz, redemption_count bigint, total_saved numeric
)
language sql stable security definer set search_path = public as $$
  select
    dc.id, dc.code, dc.discount_value, dc.active, dc.expires_at, dc.max_redemptions, dc.created_at,
    coalesce(r.redemption_count, 0), coalesce(r.total_saved, 0)
  from discount_codes dc
  left join (
    select discount_code_id, count(*) as redemption_count, sum(amount_saved) as total_saved
    from discount_redemptions group by discount_code_id
  ) r on r.discount_code_id = dc.id
  where is_admin()
  order by dc.created_at desc;
$$;
revoke execute on function admin_list_discount_codes() from public;
grant execute on function admin_list_discount_codes() to authenticated;

-- Redemption detail for one code, plus the hauler's display name.
create function admin_discount_code_redemptions(p_code_id uuid)
returns table (
  id uuid, hauler_id uuid, hauler_name text, job_id uuid, job_title text,
  original_rate numeric, discounted_rate numeric, amount_saved numeric, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select
    r.id, r.hauler_id, coalesce(p.business_name, p.name), r.job_id, j.title,
    r.original_rate, r.discounted_rate, r.amount_saved, r.created_at
  from discount_redemptions r
  join profiles p on p.id = r.hauler_id
  join jobs j on j.id = r.job_id
  where is_admin() and r.discount_code_id = p_code_id
  order by r.created_at desc;
$$;
revoke execute on function admin_discount_code_redemptions(uuid) from public;
grant execute on function admin_discount_code_redemptions(uuid) to authenticated;

-- Overall program stats — separate from the per-code list so the admin summary header can load
-- independently of how many codes exist.
create function admin_discount_program_stats()
returns table (total_codes bigint, total_redemptions bigint, total_saved numeric)
language sql stable security definer set search_path = public as $$
  select
    (select count(*) from discount_codes where is_admin()),
    (select count(*) from discount_redemptions where is_admin()),
    (select coalesce(sum(amount_saved), 0) from discount_redemptions where is_admin());
$$;
revoke execute on function admin_discount_program_stats() from public;
grant execute on function admin_discount_program_stats() to authenticated;
