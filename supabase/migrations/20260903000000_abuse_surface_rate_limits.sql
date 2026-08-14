-- MyTrashBid — rate limits found by the pre-live-Stripe security audit
--
-- Three gaps, none catastrophic on their own but all worth closing before real money and (soon)
-- real SMS spend are on the line:
--   1. resend_verification_email() had no cooldown — a logged-in-but-unverified user could
--      script-loop it to burn Resend send volume.
--   2. Chat messages had no length cap and no flood control, and every message triggers a real
--      notification (email today, SMS once AWS SNS creds are set) to the OTHER party — a genuine
--      harassment vector against a match partner, not just a self-directed cost issue.
--   3. Job posting had no per-user cap — each post fans out newJobNearby notifications to every
--      nearby hauler, so a flood of fake posts is a cost/nuisance vector too.

-- ─── 1. resend_verification_email() cooldown ──────────────────────────────────────────────────

alter table profiles add column email_verify_last_sent_at timestamptz;

-- email_verify_last_sent_at must be RPC-only (same reasoning as every other lifecycle column
-- locked down here) — otherwise a user could just reset it to null via a plain profile update
-- and the cooldown below would be meaningless. Byte-for-byte identical to the current definition
-- otherwise.
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

create or replace function resend_verification_email() returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_verified timestamptz;
  v_last_sent timestamptz;
begin
  select email_verified_at, email_verify_last_sent_at into v_verified, v_last_sent
    from profiles where id = auth.uid();
  if v_verified is not null then
    raise exception 'This account is already verified.';
  end if;
  if v_last_sent is not null and v_last_sent > now() - interval '60 seconds' then
    raise exception 'Please wait a minute before requesting another verification email.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    email_verify_token = encode(extensions.gen_random_bytes(24), 'hex'),
    email_verify_last_sent_at = now()
  where id = auth.uid();

  perform dispatch_verification_email(auth.uid());
end;
$$;

-- ─── 2. Chat messages: length cap + per-chat flood control ────────────────────────────────────

alter table messages add constraint messages_text_length check (char_length(text) <= 2000);

-- Per-chat, not global — a chat only ever has one customer and one hauler, so this bounds "one
-- party flooding the other" without needing to touch every chat a user is in. 10 messages per 10
-- seconds is generous for real back-and-forth typing but stops a scripted flood; both numbers are
-- easy to retune later if real usage says otherwise.
create function guard_message_rate_limit() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_recent_count int;
begin
  if new.sender_role in ('customer', 'hauler') then
    select count(*) into v_recent_count from messages
      where chat_id = new.chat_id and sender_id = new.sender_id and created_at > now() - interval '10 seconds';
    if v_recent_count >= 10 then
      raise exception 'You''re sending messages too quickly — please slow down and try again in a few seconds.';
    end if;
  end if;
  return new;
end;
$$;

create trigger messages_rate_limit before insert on messages
  for each row execute function guard_message_rate_limit();

-- ─── 3. Job posting: per-user daily cap ────────────────────────────────────────────────────────

-- 20/day is generous for a legitimate heavy poster (e.g. a property manager) but bounds a script
-- flooding nearby haulers with newJobNearby notifications.
create function guard_job_posting_rate_limit() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_recent_count int;
begin
  select count(*) into v_recent_count from jobs
    where customer_id = new.customer_id and created_at > now() - interval '1 day';
  if v_recent_count >= 20 then
    raise exception 'You''ve posted a lot of jobs today — contact support if you need to post more.';
  end if;
  return new;
end;
$$;

create trigger jobs_posting_rate_limit before insert on jobs
  for each row execute function guard_job_posting_rate_limit();
