-- Stripe Connect Express onboarding — Phase 1 of the payment rework ported from MyPartyBid
-- (same architecture, applied here with "hauler" in place of "vendor" throughout — this app has
-- no job-category-matching system, so nothing category-related is touched).
--
-- Today this app moves money two ways depending on jobs.payment_mode: 'deposit' charges the
-- customer 10% via a plain PaymentIntent and the hauler collects the rest off-platform;
-- 'full' authorizes a hold 48h before the service date and captures at completion — the hauler
-- is still paid off-platform, tracked only as a bookkeeping figure. Neither mode has ever moved
-- money to the hauler through Stripe. This phase adds Stripe Connect Express onboarding so a
-- later phase can replace both modes with one flow: charge the customer in full at acceptance,
-- hold it in the platform's own Stripe balance, and transfer the hauler's share only after the
-- customer confirms completion (or 48h passes, or an admin resolves a dispute).

-- ─── 1. profiles: Connect account columns ──────────────────────────────────────────────────────
-- "Onboarded" = charges_enabled AND payouts_enabled, always re-derived from the two booleans,
-- never branched on stripe_connect_onboarded_at alone (Stripe can flip a restricted account back
-- off after the fact).
alter table profiles add column stripe_connect_account_id text;
alter table profiles add column stripe_connect_details_submitted boolean not null default false;
alter table profiles add column stripe_connect_charges_enabled boolean not null default false;
alter table profiles add column stripe_connect_payouts_enabled boolean not null default false;
alter table profiles add column stripe_connect_onboarded_at timestamptz;

create unique index profiles_stripe_connect_account_id_idx on profiles (stripe_connect_account_id)
  where stripe_connect_account_id is not null;

-- guard_profile_self_update(): a hauler must never self-mark their own Connect status. Byte-for-
-- byte identical to the current definition (20260903000000_abuse_surface_rate_limits.sql:21-83)
-- otherwise — just the four new booleans added to the unconditional blocklist.
create or replace function guard_profile_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true' then
    return new;
  end if;

  if new.status is distinct from old.status
    or new.suspended_at is distinct from old.suspended_at
    or new.suspended_by_admin_id is distinct from old.suspended_by_admin_id
    or new.suspension_reason is distinct from old.suspension_reason
    or new.bidding_restricted is distinct from old.bidding_restricted
    or new.posting_restricted is distinct from old.posting_restricted
    or new.deletion_requested_at is distinct from old.deletion_requested_at
    or new.deletion_reason is distinct from old.deletion_reason
    or new.deletion_scheduled_for is distinct from old.deletion_scheduled_for
    or new.anonymized_at is distinct from old.anonymized_at
    or new.deleted_at is distinct from old.deleted_at
    or new.retention_until is distinct from old.retention_until
    or new.verified is distinct from old.verified
    or new.license_active is distinct from old.license_active
    or new.insurance_active is distinct from old.insurance_active
    or new.territory_id is distinct from old.territory_id
    or new.email_verify_last_sent_at is distinct from old.email_verify_last_sent_at
    or new.stripe_connect_details_submitted is distinct from old.stripe_connect_details_submitted
    or new.stripe_connect_charges_enabled is distinct from old.stripe_connect_charges_enabled
    or new.stripe_connect_payouts_enabled is distinct from old.stripe_connect_payouts_enabled
    or new.stripe_connect_onboarded_at is distinct from old.stripe_connect_onboarded_at
  then
    raise exception 'Not permitted to change this field.';
  end if;

  if new.id is distinct from auth.uid() then
    if old.super_admin and (
      new.active is distinct from old.active
      or new.role is distinct from old.role
      or new.admin_read_only is distinct from old.admin_read_only
      or new.super_admin is distinct from old.super_admin
    ) then
      raise exception 'The super admin account cannot be deactivated or modified by another admin.';
    end if;
    return new;
  end if;

  if is_full_admin() then
    return new;
  end if;

  if new.role is distinct from old.role
    or new.rating is distinct from old.rating
    or new.rating_count is distinct from old.rating_count
    or new.email_verified_at is distinct from old.email_verified_at
    or new.email_verify_token is distinct from old.email_verify_token
    or new.admin_read_only is distinct from old.admin_read_only
    or new.super_admin is distinct from old.super_admin
    or new.membership_tier is distinct from old.membership_tier
    or new.business_name is distinct from old.business_name
    or new.license_number is distinct from old.license_number
    or new.insurance_info is distinct from old.insurance_info
    or new.business_registration_number is distinct from old.business_registration_number
    or (new.active and not old.active)
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- Service-role-only, mirrors the existing admin_reset_user_mfa-style trust boundary — called only
-- from the stripe-webhook Edge Function's account.updated handler, never from client code.
create function apply_connect_account_status(
  p_account_id text, p_charges_enabled boolean, p_payouts_enabled boolean, p_details_submitted boolean
) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the service role can apply Connect account status.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    stripe_connect_charges_enabled = p_charges_enabled,
    stripe_connect_payouts_enabled = p_payouts_enabled,
    stripe_connect_details_submitted = p_details_submitted,
    stripe_connect_onboarded_at = case
      when p_charges_enabled and p_payouts_enabled and stripe_connect_onboarded_at is null then now()
      else stripe_connect_onboarded_at
    end
  where stripe_connect_account_id = p_account_id;
end;
$$;
revoke execute on function apply_connect_account_status(text, boolean, boolean, boolean) from public;

-- One-time-set by the create-connect-account Edge Function right after stripe.accounts.create().
create function set_own_connect_account_id(p_account_id text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set stripe_connect_account_id = p_account_id
  where id = auth.uid() and stripe_connect_account_id is null;
  if not found then
    raise exception 'Connect account already set for this profile.';
  end if;
end;
$$;
revoke execute on function set_own_connect_account_id(text) from public;
grant execute on function set_own_connect_account_id(text) to authenticated;

-- ─── 2. platform_fee_config: service_fee_rate ──────────────────────────────────────────────────
-- Charged to the customer separately from the hauler's bid amount and the platform's commission,
-- so commission nets fully after Stripe's processing cut. Default 3%, admin-configurable.
alter table platform_fee_config add column service_fee_rate numeric(5,4) not null default 0.03
  check (service_fee_rate >= 0 and service_fee_rate < 1);

alter table platform_fee_audit_log drop constraint platform_fee_audit_log_action_check;
alter table platform_fee_audit_log add constraint platform_fee_audit_log_action_check
  check (action in ('global_rate_set', 'tier_rate_set', 'admin_edit_toggle_set', 'service_fee_rate_set'));

create function set_service_fee_rate(p_rate numeric) returns void
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
    raise exception 'Service fee rate must be between 0 and 1.';
  end if;

  update platform_fee_config set service_fee_rate = p_rate, updated_at = now() where id = true;
  perform log_platform_fee_change('service_fee_rate_set', null, v_cfg.service_fee_rate::text, p_rate::text);
end;
$$;
revoke execute on function set_service_fee_rate(numeric) from public;
grant execute on function set_service_fee_rate(numeric) to authenticated;

-- ─── 3. Hard block: a hauler cannot bid until Connect onboarding is fully complete ─────────────
-- Mirrors why bids_enforce_amount_limits (20260819000000_money_policy_limits.sql:91) is a trigger
-- and not folded into RLS — RLS violations only ever return a generic Postgres error, no custom
-- text the frontend can show.
create function enforce_hauler_connect_onboarded() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_charges_enabled boolean;
  v_payouts_enabled boolean;
begin
  select stripe_connect_charges_enabled, stripe_connect_payouts_enabled
    into v_charges_enabled, v_payouts_enabled
    from profiles where id = new.hauler_id;
  if not coalesce(v_charges_enabled, false) or not coalesce(v_payouts_enabled, false) then
    raise exception 'CONNECT_ONBOARDING_REQUIRED: Complete Stripe Connect onboarding before bidding.';
  end if;
  return new;
end;
$$;

create trigger bids_enforce_connect_onboarded before insert on bids
  for each row execute function enforce_hauler_connect_onboarded();
