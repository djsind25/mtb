-- MyTrashBid — close the hauler-verification bypass
--
-- The marketing copy promises license/insurance vetting, backed by a real flow: hauler uploads a
-- document, a full admin reviews it via review_hauler_document() (20260716214330_..., latest
-- version in 20260717010000_view_only_admin.sql), which stamps reviewed_by/reviewed_at/
-- reviewer_note on the hauler_documents row before flipping profiles.verified/license_active/
-- insurance_active. But EditUserModal.jsx also let any full admin flip those same three columns
-- directly via a plain updateUserProfile() table write — no reason, no audit trail, no record of
-- why "verified" stopped meaning "a document was actually reviewed." This migration closes that
-- specific gap the same way 20260815000000 closed the account-lifecycle one: the fields become
-- RPC-only (even for full admins), and the one legitimate override path requires a reason and
-- writes to the same account_lifecycle_audit_log used everywhere else. review_hauler_document()
-- itself is untouched — it already sets app.bypass_profile_guard before writing, so it keeps
-- working exactly as before.

alter table account_lifecycle_audit_log drop constraint account_lifecycle_audit_log_action_check;
alter table account_lifecycle_audit_log add constraint account_lifecycle_audit_log_action_check
  check (action in (
    'deletion_requested', 'deletion_cancelled_self', 'deletion_cancelled_admin',
    'deletion_started_admin', 'deletion_paused_blocker_found',
    'suspended', 'restored', 'bidding_restricted_set', 'posting_restricted_set',
    'anonymized', 'marked_deleted', 'files_purged',
    'hauler_verification_flag_set'
  ));

-- guard_profile_self_update(): verified/license_active/insurance_active move from the
-- "non-self, non-full-admin" blocklist (bottom) into the unconditional one (top) — closing the
-- exact same class of gap 20260815000000 closed for status/suspended_at/etc. Byte-for-byte
-- identical otherwise.
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

-- One centralized override RPC for all three fields, rather than three near-duplicate ones —
-- same reasoning as admin_set_bidding_restricted/admin_set_posting_restricted being kept separate
-- (they gate different roles), but these three all gate the same role (hauler) and the same
-- underlying concept (verification status), so a single reason/audit/reauth chain covers all of
-- them cleanly via p_field.
create function admin_set_hauler_verification_flag(
  p_user_id uuid, p_field text, p_value boolean, p_reason text, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype; v_old_value boolean;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can change hauler verification status.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;
  if p_field not in ('verified', 'license_active', 'insurance_active') then
    raise exception 'Invalid verification field.';
  end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role <> 'hauler' then raise exception 'Only hauler accounts have a verification status.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  if p_field = 'verified' then
    v_old_value := v_profile.verified;
    update profiles set verified = p_value where id = p_user_id;
  elsif p_field = 'license_active' then
    v_old_value := v_profile.license_active;
    update profiles set license_active = p_value where id = p_user_id;
  else
    v_old_value := v_profile.insurance_active;
    update profiles set insurance_active = p_value where id = p_user_id;
  end if;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'hauler_verification_flag_set', null, null,
    p_reason, jsonb_build_object('field', p_field, 'old_value', v_old_value, 'new_value', p_value),
    false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_set_hauler_verification_flag(uuid, text, boolean, text, text) from public;
grant execute on function admin_set_hauler_verification_flag(uuid, text, boolean, text, text) to authenticated;
