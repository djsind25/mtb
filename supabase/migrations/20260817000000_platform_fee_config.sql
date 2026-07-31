-- MyTrashBid — admin-configurable platform fees (global default + per-tier overrides)
--
-- price_breakdown()'s 10% commission has been a single hardcoded app_config value
-- (commission_rate) since day one; membership.js's entitlements.commissionRate is a same-shaped
-- per-tier field that's existed since 20260730000000_membership_and_profile_locking.sql but was
-- always decorative — every tier hardcodes 0.10, it's only read for BidRow.jsx's pre-bid preview
-- number, and its SQL mirror membership_commission_rate() (added in that same migration,
-- explicitly as "infrastructure only... a future tier-specific value to plug into") is never
-- called anywhere. This migration is that future: a real global+per-tier rate, admin-editable,
-- super_admin/admin permission-gated, audited, and frozen onto each job at bid acceptance so a
-- later rate change never reaches back into an already-booked job — the same append-only
-- principle commission itself already gets (price_breakdown() stamps it once onto chats.commission,
-- and guard_chat_self_update() already protects it from being touched again).
--
-- Role split: super_admin/admin already exists (profiles.super_admin, is_super_admin(),
-- session.superAdmin) — reused as-is, no new role plumbing.

-- ── 1. Storage: a small dedicated table, not more app_config rows ──────────────────────────────
-- app_config's RLS (app_config_admin_write) is a blanket is_full_admin() policy with no per-key
-- distinction — reusing it here would mean scattering a second permission model (super_admin vs.
-- toggle-gated admin) into that one shared policy's clause for just these few keys, sitting oddly
-- next to unrelated config like functions_base_url. A dedicated table gets its own narrow RLS
-- instead: read open to any admin (view-only included — "view all rates" applies to everyone with
-- the admin role), and NO write policy for `authenticated` at all — every mutation goes through
-- the three RPCs below, the same "no policy, RPC-only" idiom account_lifecycle_audit_log already
-- established for exactly this reason (so every write is guaranteed to pass through validation +
-- audit logging, never bypassable via a raw table update).
create table platform_fee_config (
  id                     boolean primary key default true check (id),
  global_rate            numeric(5,4) not null,
  free_tier_rate         numeric(5,4),
  pro_tier_rate          numeric(5,4),
  premium_tier_rate      numeric(5,4),
  allow_admin_fee_edits  boolean not null default false,
  updated_at             timestamptz not null default now()
);
insert into platform_fee_config (id, global_rate) values (true, app_config_numeric('commission_rate'));

alter table platform_fee_config enable row level security;
grant select on platform_fee_config to authenticated;
create policy platform_fee_config_select on platform_fee_config for select using (is_admin());

-- ── 2. Audit log — same append-only, admin-read-only, RPC-write-only shape as
-- account_lifecycle_audit_log, but keyed to a config change rather than a target user (a fee
-- change doesn't belong to one user, so there's no target_user_id column here). ──────────────────
create table platform_fee_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid not null references profiles(id),
  action      text not null check (action in ('global_rate_set', 'tier_rate_set', 'admin_edit_toggle_set')),
  tier        text check (tier in ('free', 'pro', 'premium')),
  old_value   text,
  new_value   text,
  created_at  timestamptz not null default now()
);
create index platform_fee_audit_log_created_idx on platform_fee_audit_log (created_at desc);

alter table platform_fee_audit_log enable row level security;
grant select on platform_fee_audit_log to authenticated;
create policy platform_fee_audit_log_select on platform_fee_audit_log for select using (is_admin());

-- Internal only — never granted to authenticated, callable only from inside the RPCs below (same
-- convention as log_account_lifecycle_event).
create function log_platform_fee_change(p_action text, p_tier text, p_old_value text, p_new_value text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into platform_fee_audit_log (actor_id, action, tier, old_value, new_value)
  values (auth.uid(), p_action, p_tier, p_old_value, p_new_value);
end;
$$;
revoke execute on function log_platform_fee_change(text, text, text, text) from public;

-- ── 3. Tier-rate resolution — repurposes the dead membership_commission_rate() seam rather than
-- adding a new function name. Tier override if set, else the global default. ──────────────────────
create or replace function membership_commission_rate(p_tier text) returns numeric
  language sql stable security definer set search_path = public as $$
    select coalesce(
      case p_tier
        when 'pro' then (select pro_tier_rate from platform_fee_config)
        when 'premium' then (select premium_tier_rate from platform_fee_config)
        else (select free_tier_rate from platform_fee_config)
      end,
      (select global_rate from platform_fee_config)
    );
  $$;

-- ── 4. price_breakdown(): add an optional explicit-rate parameter. This changes the function's
-- signature (not just its body), so — same as every other signature change in this repo
-- (accept_bid, job_refundable_charges) — CREATE OR REPLACE can't do this in place; it needs a
-- real drop-and-recreate. Every existing call site keeps working unchanged (implicit null ->
-- exactly today's global-only behavior via the coalesce below); only accept_bid()/
-- finalize_bid_switch() below pass an explicit resolved rate. platform_fee_config.global_rate is
-- now the single source of truth for the global default — app_config.commission_rate is left in
-- place (harmless) but nothing new reads it.
-- security definer (the pre-existing version was plain "language sql stable", no security clause)
-- because its fallback now reads platform_fee_config, which is RLS-restricted to is_admin() —
-- without this, a non-admin caller (any customer/hauler, since this is granted to anon+authenticated)
-- would see that subquery return null via RLS, breaking the whole calculation for everyone but
-- admins. Same reasoning is_admin()/is_active_user()/app_config_numeric() are already definer.
drop function if exists price_breakdown(numeric, text);
create function price_breakdown(p_amount numeric, p_payment_mode text default 'deposit', p_commission_rate numeric default null)
returns table (amount numeric, fee numeric, deposit_now numeric, balance_due numeric)
language sql stable security definer set search_path = public as $$
  select
    p_amount,
    round(p_amount * coalesce(p_commission_rate, (select global_rate from platform_fee_config)), 2),
    case when p_payment_mode = 'full' then p_amount
      else round(p_amount * coalesce(p_commission_rate, (select global_rate from platform_fee_config)), 2)
    end,
    case when p_payment_mode = 'full' then 0
      else round(p_amount - round(p_amount * coalesce(p_commission_rate, (select global_rate from platform_fee_config)), 2), 2)
    end;
$$;
grant execute on function price_breakdown(numeric, text, numeric) to anon, authenticated;

-- ── 5. Freeze the rate at acceptance: chats.commission_rate, stamped once by accept_bid() and
-- finalize_bid_switch() (the only two call sites that create a new chats row), protected by
-- guard_chat_self_update() exactly like commission already is. Nothing backfills existing rows —
-- they keep null, and nothing ever reads this column for math (only chats.commission, already
-- frozen, drives every downstream dollar calculation), so old jobs render/calculate exactly as
-- they did before this migration. ──────────────────────────────────────────────────────────────
alter table chats add column commission_rate numeric(5,4);

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
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- ── 6. accept_bid(): resolve the hauler's effective rate and stamp it. Byte-for-byte identical
-- to the 20260813 version otherwise — same signature, so a plain create-or-replace is enough. ────
create or replace function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric, payment_mode text)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_rate numeric;
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

  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_bid.hauler_id;
  select * into v_pb from price_breakdown(v_bid.amount, v_job.payment_mode, v_rate);

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
    coordination_deadline
  )
  values (
    p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_rate, v_job.payment_mode,
    case when v_job.payment_mode = 'full' then now() + interval '48 hours' else null end
  )
  returning id into v_chat_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat_id, 'system',
    case when v_job.payment_mode = 'full'
      then 'Once the job date is agreed upon, the payment portal opens. Payment is securely processed, and the hauler is paid after the job is confirmed complete.'
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

-- ── 7. finalize_bid_switch(): same treatment — resolve the new hauler's rate, stamp it. Same
-- signature as the 20260725 version, byte-for-byte identical otherwise. ───────────────────────────
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
  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_new_bid.hauler_id;
  select * into v_pb from price_breakdown(v_new_bid.amount, v_job.payment_mode, v_rate);

  delete from job_completion_photos where job_id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set superseded_at = now() where id = v_old_chat.id;

  insert into chats (job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode)
  values (p_job_id, v_job.customer_id, v_new_bid.hauler_id, v_new_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_rate, v_job.payment_mode)
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

-- ── 8. dispatch_monthly_export(): the automated monthly revenue email reads the commission rate
-- directly from app_config (v_rate := app_config_numeric('commission_rate')) — repointed at the
-- new single source of truth so it doesn't silently go stale the first time an admin changes the
-- global rate. Everything else in this function is byte-for-byte identical to the 20260725
-- version — same signature, same jsonb/net.http_post shape, only that one assignment changes.
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
  v_rate := (select global_rate from platform_fee_config);

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

-- ── 9. Admin RPCs — set_global_platform_fee_rate / set_tier_platform_fee_rate: is_full_admin()
-- baseline (blocks view-only admins entirely, same as every other mutation), plus is_super_admin()
-- OR the allow_admin_fee_edits toggle. set_allow_admin_fee_edits: is_super_admin() ALWAYS —
-- regardless of its own current value, since a regular admin must never be able to grant itself
-- edit rights. Every mutation logs to platform_fee_audit_log. ────────────────────────────────────
create function set_global_platform_fee_rate(p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg platform_fee_config%rowtype;
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only an admin can change platform fees.';
  end if;
  select * into v_cfg from platform_fee_config where id = true for update;
  if not is_super_admin() and not v_cfg.allow_admin_fee_edits then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Regular admins cannot edit platform fees while admin fee edits are turned off.';
  end if;
  if p_rate is null or p_rate < 0 or p_rate >= 1 then
    raise exception 'Platform fee rate must be between 0 and 1.';
  end if;

  update platform_fee_config set global_rate = p_rate, updated_at = now() where id = true;
  perform log_platform_fee_change('global_rate_set', null, v_cfg.global_rate::text, p_rate::text);
end;
$$;
revoke execute on function set_global_platform_fee_rate(numeric) from public;
grant execute on function set_global_platform_fee_rate(numeric) to authenticated;

-- p_rate = null clears the tier's override, falling back to the global default.
create function set_tier_platform_fee_rate(p_tier text, p_rate numeric) returns void
language plpgsql security definer set search_path = public as $$
declare v_cfg platform_fee_config%rowtype; v_old numeric;
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only an admin can change platform fees.';
  end if;
  if p_tier not in ('free', 'pro', 'premium') then
    raise exception 'Invalid membership tier.';
  end if;
  select * into v_cfg from platform_fee_config where id = true for update;
  if not is_super_admin() and not v_cfg.allow_admin_fee_edits then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Regular admins cannot edit platform fees while admin fee edits are turned off.';
  end if;
  if p_rate is not null and (p_rate < 0 or p_rate >= 1) then
    raise exception 'Platform fee rate must be between 0 and 1.';
  end if;

  v_old := case p_tier when 'free' then v_cfg.free_tier_rate when 'pro' then v_cfg.pro_tier_rate else v_cfg.premium_tier_rate end;
  update platform_fee_config set
    free_tier_rate = case when p_tier = 'free' then p_rate else free_tier_rate end,
    pro_tier_rate = case when p_tier = 'pro' then p_rate else pro_tier_rate end,
    premium_tier_rate = case when p_tier = 'premium' then p_rate else premium_tier_rate end,
    updated_at = now()
  where id = true;
  perform log_platform_fee_change('tier_rate_set', p_tier, v_old::text, p_rate::text);
end;
$$;
revoke execute on function set_tier_platform_fee_rate(text, numeric) from public;
grant execute on function set_tier_platform_fee_rate(text, numeric) to authenticated;

create function set_allow_admin_fee_edits(p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_old boolean;
begin
  if not is_super_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can change this setting.';
  end if;
  select allow_admin_fee_edits into v_old from platform_fee_config where id = true;
  update platform_fee_config set allow_admin_fee_edits = p_enabled, updated_at = now() where id = true;
  perform log_platform_fee_change('admin_edit_toggle_set', null, v_old::text, p_enabled::text);
end;
$$;
revoke execute on function set_allow_admin_fee_edits(boolean) from public;
grant execute on function set_allow_admin_fee_edits(boolean) to authenticated;
