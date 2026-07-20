-- Fixes for the 15 findings from the max-effort code review of the payment-rework arc
-- (Phases 1-3 + completion workflow). See that review's report for full context; each block
-- below is one finding.

-- ─── Fix #1 (critical): a read-only admin could trigger a real Stripe refund, and two
-- concurrent refund attempts on the same request could both go through ────────────────────────
-- process-cancellation-refund only checked is_admin() (via job_refundable_charges) before
-- calling Stripe — the is_full_admin() check lived inside resolve_cancellation, which doesn't
-- run until after the refund. And the pending-status check was a plain SELECT with no lock, so
-- two near-simultaneous calls could both read 'pending' before either wrote anything. This pair
-- of functions moves both checks to the very start, atomically: claim_cancellation_for_refund
-- verifies is_full_admin() AND flips a dedicated flag in one UPDATE guarded by
-- "status = 'pending' and refund_in_progress = false" — Postgres serializes concurrent UPDATEs
-- to the same row, so only one caller's WHERE clause can still match once the first commits.
-- refund_in_progress is a separate column from status/resolved_by (rather than reusing either)
-- so a stuck claim can be told apart from a real resolution or the pre-existing pending state.
alter table cancellation_requests add column refund_in_progress boolean not null default false;

create function claim_cancellation_for_refund(p_request_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve cancellation requests';
  end if;
  update cancellation_requests set refund_in_progress = true
    where id = p_request_id and status = 'pending' and refund_in_progress = false;
  if not found then
    raise exception 'This request is already being processed or has been resolved.';
  end if;
end;
$$;
revoke execute on function claim_cancellation_for_refund(uuid) from public;
grant execute on function claim_cancellation_for_refund(uuid) to authenticated;

-- Only for the case where the claim never made it to resolve_cancellation at all (e.g. the
-- very first Stripe call failed before any money moved) — lets the same request be retried
-- cleanly instead of looking permanently "in progress". Never touches an already-resolved row.
create function release_cancellation_claim(p_request_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve cancellation requests';
  end if;
  update cancellation_requests set refund_in_progress = false
    where id = p_request_id and status = 'pending';
end;
$$;
revoke execute on function release_cancellation_claim(uuid) from public;
grant execute on function release_cancellation_claim(uuid) to authenticated;

-- ─── Fix #2 (critical): hauler_owns_chat_job never learned about hauler-switching ─────────────
-- Every sibling job/chat lookup added alongside superseded_at (hauler_mark_done,
-- customer_acknowledge_completion, admin_review_completion, send_overdue_reminders) got a
-- "superseded_at is null" filter so a switched-out hauler's old chat row stops granting live
-- access. This one — which gates every job_completion_photos policy and every completion-photos
-- storage policy — was missed, so an ousted hauler kept full read/write/delete access to the
-- job's completion photos indefinitely.
create or replace function hauler_owns_chat_job(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from chats
      where chats.job_id = p_job_id and chats.hauler_id = auth.uid() and chats.superseded_at is null
    );
  $$;

-- ─── Fix #4 (critical) + Fix #7: completion workflow didn't check for an already-resolved
-- cancellation, and checked the cancellation-pending state before caller ownership ─────────────
-- hauler_mark_done/customer_acknowledge_completion only ever guarded against a *pending*
-- cancellation request — once admin resolved one (refunding the customer, jobs.status set to
-- 'cancelled'), nothing stopped the job from later being marked complete and commission
-- "earned" on top of money that was already returned. Same gap in the auto-acknowledge cron,
-- a third, independent code path that bypasses both RPCs entirely.
-- Fix #7 is bundled in here since it's the same two functions: the pending-cancellation check
-- ran before the ownership check, so an unrelated caller who guessed a job_id could learn
-- whether it had an open cancellation dispute before ever being told they don't own it. Ownership
-- is now checked first in both.
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

  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before marking work complete';
  end if;

  select * into v_job from jobs where id = p_job_id;
  if v_job.status <> 'booked' then
    raise exception 'This job is no longer booked';
  end if;

  select
    count(*) filter (where phase = 'before'),
    count(*) filter (where phase = 'after')
  into v_before, v_after
  from job_completion_photos where job_id = p_job_id;
  if v_before < 1 or v_after < 1 then
    raise exception 'Upload at least one before photo and one after photo before marking complete';
  end if;

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

  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before acknowledging completion';
  end if;

  select * into v_job from jobs where id = p_job_id;
  if v_job.status <> 'booked' then
    raise exception 'This job is no longer booked';
  end if;
  perform finalize_completion(v_chat, v_job, false);
end;
$$;

create or replace function auto_acknowledge_stale_completions() returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
  v_job jobs%rowtype;
  v_window int;
  r record;
begin
  v_window := app_config_numeric('ack_auto_window_days')::int;
  for r in
    select c.id from chats c
    join jobs j on j.id = c.job_id
    where c.hauler_done_at is not null
      and c.customer_ack_at is null
      and c.hauler_done_at < now() - make_interval(days => v_window)
      and j.status = 'booked'
  loop
    select * into v_chat from chats where id = r.id;
    select * into v_job from jobs where id = v_chat.job_id;
    perform finalize_completion(v_chat, v_job, true);
  end loop;
end;
$$;

-- ─── Fix #12: the automated monthly admin email still used deposit-only math for every booked
-- job, including full-payment ones ─────────────────────────────────────────────────────────────
-- RevenueTab.jsx's buildMonthlyRevenue was updated to exclude full-mode jobs from the
-- gmv/deposit/haulerDirect split (that split only means anything for deposit-mode), but this
-- SQL function — which drives the actual monthly email, not the dashboard — was never updated,
-- so it kept reporting "90% paid hauler-direct" for jobs where MyTrashBid was actually holding
-- the full amount in Stripe.
create or replace function dispatch_monthly_export(p_month_start date, p_month_end date) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_super_email text;
  v_month_label text;
  v_base_url text;
  v_key text;
  v_revenue jsonb;
  v_jobs jsonb;
  v_rate numeric;
begin
  select email into v_super_email from profiles where role = 'admin' and super_admin limit 1;
  if v_super_email is null then
    return;
  end if;

  v_month_label := to_char(p_month_start, 'Mon YYYY');
  v_rate := app_config_numeric('commission_rate');

  select jsonb_build_object(
    'bookedJobs', count(*),
    'gmv', coalesce(sum(b.amount), 0),
    'deposit', coalesce(sum(b.amount) * v_rate, 0),
    'haulerDirect', coalesce(sum(b.amount) * (1 - v_rate), 0)
  ) into v_revenue
  from jobs j
  join bids b on b.id = j.accepted_bid_id
  where j.status = 'booked'
    and j.payment_mode = 'deposit'
    and coalesce(j.accepted_at, j.created_at)::date between p_month_start and p_month_end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'title', j.title,
    'customer', cp.name,
    'hauler', coalesce(hp.business_name, hp.name),
    'amount', b.amount,
    'completedAt', j.completed_at
  ) order by j.completed_at), '[]'::jsonb) into v_jobs
  from jobs j
  join bids b on b.id = j.accepted_bid_id
  join profiles cp on cp.id = j.customer_id
  join profiles hp on hp.id = b.hauler_id
  where j.completed = true
    and j.completed_at::date between p_month_start and p_month_end;

  select value into v_base_url from app_config where key = 'functions_base_url';
  select value into v_key from app_config where key = 'internal_dispatch_key';
  if v_base_url is null or v_base_url = '' then
    return;
  end if;

  perform net.http_post(
    url := v_base_url || '/send-monthly-export',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object(
      'email', v_super_email,
      'monthLabel', v_month_label,
      'revenue', v_revenue,
      'completedJobs', v_jobs
    )
  );
exception when others then
  raise warning 'dispatch_monthly_export failed: %', sqlerrm;
end;
$$;

-- ─── Fix #15: switching to a cheaper bid could only refund against the single most recent
-- charge, so a job switched more than once (multiple succeeded PaymentIntents) could fail to
-- refund even when the aggregate held funds were sufficient ────────────────────────────────────
-- Mirrors job_refundable_charges (used by the admin cancellation-refund flow) but without its
-- is_admin() gate, since this is called via service-role from switch-bid-payment on behalf of
-- an untrusted customer caller — same trust model as latest_job_charge, which it replaces.
create function job_refundable_charges_for_switch(p_job_id uuid)
  returns table(stripe_payment_intent_id text, charged numeric, refundable numeric)
  language plpgsql stable security definer set search_path = public as $$
begin
  return query
    select
      c.stripe_payment_intent_id,
      c.amount as charged,
      c.amount - coalesce((
        select sum(r.amount) from payments r
        where r.kind = 'refund' and r.status = 'succeeded' and r.stripe_payment_intent_id = c.stripe_payment_intent_id
      ), 0) as refundable
    from payments c
    where c.job_id = p_job_id and c.kind = 'charge' and c.status = 'succeeded'
    order by c.created_at asc;
end;
$$;
revoke execute on function job_refundable_charges_for_switch(uuid) from public;
grant execute on function job_refundable_charges_for_switch(uuid) to service_role;

-- p_refunds, when provided, replaces the single p_kind/p_amount/p_stripe_payment_intent_id path
-- with a loop-insert of one payments row per split refund — same shape as resolve_cancellation's
-- p_refunds, so switch-bid-payment can now split a delta<0 refund across more than one charge.
-- The delta>0 (new charge) and delta=0 paths are untouched — a switch never creates more than
-- one new charge, only ever needs to split a refund.
-- Adding a parameter changes the function's identity, so "create or replace" alone would leave
-- the old 6-arg version behind as a separate overload instead of truly replacing it — drop it
-- explicitly first.
drop function if exists finalize_bid_switch(uuid, uuid, uuid, text, numeric, text);

create function finalize_bid_switch(
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
  if v_job.payment_mode <> 'full' then
    raise exception 'Switching haulers is only available for jobs paid in full';
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
revoke execute on function finalize_bid_switch(uuid, uuid, uuid, text, numeric, text, jsonb) from public;
grant execute on function finalize_bid_switch(uuid, uuid, uuid, text, numeric, text, jsonb) to service_role;
