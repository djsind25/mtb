-- MyTrashBid — Admin account management (super_admin manages other admins) + territory CRUD
--
-- Only super_admin may block/unblock/delete another admin (full admin or territory_admin) —
-- admin_delete_user/admin_suspend_user (regular users) explicitly refuse role='admin' targets,
-- so this is genuinely new, not a variant of an existing path.

-- ─── 1. territory_id becomes RPC-only, even for full admins ──────────────────────────────────────
--
-- Without this, any full admin could reassign another admin's territory_id via a plain
-- updateUserProfile() table write (profiles_update_own's admin branch allows editing any other
-- row) — same class of gap 20260815000000/20260816000000 closed for the lifecycle/verification
-- columns. Byte-for-byte identical to the current definition otherwise.
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

-- ─── 2. Audit log action values ────────────────────────────────────────────────────────────────
--
-- Only 'admin_blocked'/'admin_unblocked' — NOT a delete action. account_lifecycle_audit_log.
-- target_user_id is `not null references profiles(id)` with no cascade, so a log row can never
-- reference an already-deleted admin (insert-after-delete violates the FK) and logging
-- before the delete would itself create a fresh FK reference that self-blocks the very deletion
-- admin_delete_admin_account is trying to perform. This mirrors admin_delete_user's existing
-- behavior exactly: a clean (zero-history) hard delete is silent by design — there's nothing to
-- audit for an account that left no trace anywhere else either.
alter table account_lifecycle_audit_log drop constraint account_lifecycle_audit_log_action_check;
alter table account_lifecycle_audit_log add constraint account_lifecycle_audit_log_action_check
  check (action in (
    'deletion_requested', 'deletion_cancelled_self', 'deletion_cancelled_admin',
    'deletion_started_admin', 'deletion_paused_blocker_found',
    'suspended', 'restored', 'bidding_restricted_set', 'posting_restricted_set',
    'anonymized', 'marked_deleted', 'files_purged',
    'hauler_verification_flag_set',
    'admin_blocked', 'admin_unblocked'
  ));

-- ─── 3. Admin account management RPCs (super_admin only) ─────────────────────────────────────────
--
-- Block/unblock reuse the existing status='suspended' lifecycle column and mechanics
-- (admin_suspend_user/admin_restore_user's shape), just for role='admin' targets and gated by
-- is_super_admin() instead of is_full_admin(). Both call require_aal2() like every other
-- sensitive admin_* RPC — StepUpChallenge auto-resolves with no visible prompt when the caller's
-- session is already AAL2, so this still delivers Derek's "single click" UX in the common case
-- without weakening the DB-level MFA requirement every other mutation here already has.

create function admin_block_admin(p_admin_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can block an admin account.'; end if;
  perform require_aal2();
  if p_admin_id = auth.uid() then raise exception 'You cannot block your own account.'; end if;

  select * into v_profile from profiles where id = p_admin_id for update;
  if v_profile.id is null then raise exception 'Admin not found.'; end if;
  if v_profile.role <> 'admin' then raise exception 'This account is not an admin.'; end if;
  if v_profile.super_admin then raise exception 'The super admin account cannot be blocked.'; end if;
  if v_profile.status = 'suspended' then raise exception 'This admin is already blocked.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'suspended', suspended_at = now(), suspended_by_admin_id = auth.uid(), suspension_reason = p_reason
  where id = p_admin_id;

  perform log_account_lifecycle_event(p_admin_id, auth.uid(), 'admin_blocked', v_profile.status, 'suspended',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_block_admin(uuid, text, text) from public;
grant execute on function admin_block_admin(uuid, text, text) to authenticated;

create function admin_unblock_admin(p_admin_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can unblock an admin account.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_admin_id for update;
  if v_profile.id is null then raise exception 'Admin not found.'; end if;
  if v_profile.role <> 'admin' then raise exception 'This account is not an admin.'; end if;
  if v_profile.status <> 'suspended' then raise exception 'This admin is not currently blocked.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'active', suspended_at = null, suspended_by_admin_id = null, suspension_reason = null
  where id = p_admin_id;

  perform log_account_lifecycle_event(p_admin_id, auth.uid(), 'admin_unblocked', 'suspended', 'active',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_unblock_admin(uuid, text, text) from public;
grant execute on function admin_unblock_admin(uuid, text, text) to authenticated;

-- Same FK-integrity pattern as admin_delete_user (20260811000000): attempt the delete and let
-- Postgres's own referential integrity reject it if this admin has any action history anywhere
-- (account_lifecycle_audit_log.actor_id, hauler_documents.reviewed_by, admin_user_flags.
-- flagged_by/resolved_by, cancellation_requests.resolved_by, etc. all reference profiles(id) with
-- no cascade) — future-proof against any new table added later that references an admin's id.
create function admin_delete_admin_account(p_admin_id uuid, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can delete an admin account.'; end if;
  perform require_aal2();
  if p_admin_id = auth.uid() then raise exception 'You cannot delete your own account.'; end if;

  select * into v_profile from profiles where id = p_admin_id;
  if v_profile.id is null then raise exception 'Admin not found.'; end if;
  if v_profile.role <> 'admin' then raise exception 'This account is not an admin.'; end if;
  if v_profile.super_admin then raise exception 'The super admin account cannot be deleted.'; end if;

  begin
    delete from auth.users where id = p_admin_id;
  exception when foreign_key_violation then
    -- Covers both "performed admin actions on record" (hauler_documents.reviewed_by,
    -- admin_user_flags.flagged_by, etc.) AND "was previously the target of a lifecycle event"
    -- (a past block/unblock, via account_lifecycle_audit_log.target_user_id) — either one is
    -- real audit history worth preserving, so both correctly block a hard delete the same way
    -- admin_delete_user already refuses any regular user who was ever suspended, not just one
    -- with a job/bid on record.
    raise exception 'This admin has account history on record (past actions, or a prior block/reactivation) and can''t be deleted — block them instead.';
  end;
end;
$$;
revoke execute on function admin_delete_admin_account(uuid, text) from public;
grant execute on function admin_delete_admin_account(uuid, text) to authenticated;

-- Informational only (never blocks) — since territory scoping is an additive restriction on top
-- of the existing full-admin/super_admin visibility, blocking/deleting the only territory_admin
-- for a territory never actually locks anyone out of those items; full admins/super_admin already
-- see them. Surfaced in the UI as a warning before block/delete, same "force"-checkbox idiom as
-- AccountDeletionsTab.
create function check_territory_admin_open_items(p_admin_id uuid)
returns table (item_type text, item_count bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_territory_id uuid;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can check this.'; end if;
  select territory_id into v_territory_id from profiles where id = p_admin_id and role = 'admin';
  if v_territory_id is null then
    return;
  end if;

  return query
  select 'open_disputes'::text, count(*) from cancellation_requests cr
    join jobs j on j.id = cr.job_id
    where cr.status = 'pending' and zip_in_territory(j.zip, v_territory_id)
  union all
  select 'pending_hauler_docs'::text, count(*) from hauler_documents hd
    join profiles p on p.id = hd.hauler_id
    where hd.status = 'pending' and zip_in_territory(p.zip, v_territory_id)
  union all
  select 'open_support_requests'::text, count(*) from support_requests sr
    join jobs j on j.id = sr.job_id
    where sr.status = 'pending' and zip_in_territory(j.zip, v_territory_id);
end;
$$;
revoke execute on function check_territory_admin_open_items(uuid) from public;
grant execute on function check_territory_admin_open_items(uuid) to authenticated;

-- ─── 4. Territory CRUD RPCs (super_admin only) ────────────────────────────────────────────────────

create function admin_create_territory(p_name text, p_scope_type text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can create a territory.'; end if;
  if p_name is null or trim(p_name) = '' then raise exception 'A name is required.'; end if;
  if p_scope_type not in ('all', 'states', 'zips') then raise exception 'Invalid scope type.'; end if;

  insert into territories (name, scope_type) values (trim(p_name), p_scope_type) returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function admin_create_territory(text, text) from public;
grant execute on function admin_create_territory(text, text) to authenticated;

create function admin_rename_territory(p_territory_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can rename a territory.'; end if;
  if p_name is null or trim(p_name) = '' then raise exception 'A name is required.'; end if;
  update territories set name = trim(p_name) where id = p_territory_id;
  if not found then raise exception 'Territory not found.'; end if;
end;
$$;
revoke execute on function admin_rename_territory(uuid, text) from public;
grant execute on function admin_rename_territory(uuid, text) to authenticated;

-- Full replace (delete+insert), matching the "paste the whole current list" UI shape — same
-- idiom as admin_assign_zips_to_territory below.
create function admin_set_territory_states(p_territory_id uuid, p_states text[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_scope_type text;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can edit a territory.'; end if;
  select scope_type into v_scope_type from territories where id = p_territory_id;
  if v_scope_type is null then raise exception 'Territory not found.'; end if;
  if v_scope_type <> 'states' then raise exception 'This territory is not a states-scoped territory.'; end if;

  delete from territory_states where territory_id = p_territory_id;
  insert into territory_states (territory_id, state)
    select p_territory_id, upper(trim(s)) from unnest(p_states) s where trim(s) <> '';
end;
$$;
revoke execute on function admin_set_territory_states(uuid, text[]) from public;
grant execute on function admin_set_territory_states(uuid, text[]) to authenticated;

create function admin_assign_zips_to_territory(p_territory_id uuid, p_zips text[]) returns void
language plpgsql security definer set search_path = public as $$
declare v_scope_type text;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can edit a territory.'; end if;
  select scope_type into v_scope_type from territories where id = p_territory_id;
  if v_scope_type is null then raise exception 'Territory not found.'; end if;
  if v_scope_type <> 'zips' then raise exception 'This territory is not a ZIP-scoped territory.'; end if;

  update zip_geo set territory_id = null where territory_id = p_territory_id;
  update zip_geo set territory_id = p_territory_id where zip = any(p_zips);
end;
$$;
revoke execute on function admin_assign_zips_to_territory(uuid, text[]) from public;
grant execute on function admin_assign_zips_to_territory(uuid, text[]) to authenticated;

create function admin_assign_admin_to_territory(p_admin_id uuid, p_territory_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can assign a territory.'; end if;

  select * into v_profile from profiles where id = p_admin_id;
  if v_profile.id is null then raise exception 'Admin not found.'; end if;
  if v_profile.role <> 'admin' then raise exception 'This account is not an admin.'; end if;
  if v_profile.super_admin then raise exception 'The super admin account is always unrestricted.'; end if;
  if p_territory_id is not null and not exists (select 1 from territories where id = p_territory_id) then
    raise exception 'Territory not found.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set territory_id = p_territory_id where id = p_admin_id;
end;
$$;
revoke execute on function admin_assign_admin_to_territory(uuid, uuid) from public;
grant execute on function admin_assign_admin_to_territory(uuid, uuid) to authenticated;

create function admin_delete_territory(p_territory_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can delete a territory.'; end if;
  if not exists (select 1 from territories where id = p_territory_id) then
    raise exception 'Territory not found.';
  end if;

  begin
    delete from territories where id = p_territory_id;
  exception when foreign_key_violation then
    raise exception 'This territory still has ZIPs or admins assigned — reassign them first.';
  end;
end;
$$;
revoke execute on function admin_delete_territory(uuid) from public;
grant execute on function admin_delete_territory(uuid) to authenticated;

-- ─── 5. Invite-as-territory_admin (extends 20260717120000_admin_invites.sql) ──────────────────────

alter table admin_invites add column territory_id uuid references territories(id);

-- The new p_territory_id param changes this function's signature (Postgres identifies functions
-- by name + argument types, not defaults) — `create or replace` alone would leave the old 2-arg
-- version in place as a separate overload, making every call ambiguous. Drop it explicitly first.
drop function if exists create_admin_invite(text, boolean);

create function create_admin_invite(p_email text, p_admin_read_only boolean default false, p_territory_id uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_invite_id uuid;
begin
  if not is_super_admin() then
    raise exception 'Only the super admin can invite new admins';
  end if;
  if v_email = '' then
    raise exception 'Email is required';
  end if;
  if exists (select 1 from profiles where lower(email) = v_email) then
    raise exception 'An account with this email already exists';
  end if;
  if exists (select 1 from admin_invites where lower(email) = v_email and accepted_at is null and expires_at > now()) then
    raise exception 'An invite is already pending for this email';
  end if;
  if p_territory_id is not null and not exists (select 1 from territories where id = p_territory_id) then
    raise exception 'Territory not found.';
  end if;

  insert into admin_invites (email, admin_read_only, territory_id, token, invited_by)
  values (v_email, p_admin_read_only, p_territory_id, encode(extensions.gen_random_bytes(24), 'hex'), auth.uid())
  returning id into v_invite_id;

  perform dispatch_admin_invite_email(v_invite_id);

  return v_invite_id;
end;
$$;
grant execute on function create_admin_invite(text, boolean, uuid) to authenticated;

-- Adds territory_id to the promoted profile alongside the existing role/admin_read_only
-- promotion — byte-for-byte identical otherwise.
create or replace function accept_admin_invite(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_invite admin_invites%rowtype;
  v_profile_id uuid;
begin
  select * into v_invite from admin_invites
    where token = p_token and accepted_at is null and expires_at > now();
  if v_invite.id is null then
    return false;
  end if;

  select id into v_profile_id from profiles where lower(email) = v_invite.email and role = 'customer';
  if v_profile_id is null then
    return false;
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set role = 'admin', admin_read_only = v_invite.admin_read_only, territory_id = v_invite.territory_id
  where id = v_profile_id;

  update admin_invites set accepted_at = now() where id = v_invite.id;

  return true;
end;
$$;
