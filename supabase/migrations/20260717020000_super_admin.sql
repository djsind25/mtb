-- MyTrashBid — a single protected super admin account
--
-- Full admins can already deactivate/demote each other via direct writes (the UI hides the
-- button for admin rows, but nothing stopped it at the RLS/trigger layer — profiles_update_own
-- allows any full admin to update any other row, super_admin included). This adds one account
-- that's off-limits to every *other* admin: its active/role/admin_read_only/super_admin fields
-- can only be changed by that account itself.

alter table profiles add column super_admin boolean not null default false;

create or replace function guard_profile_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true' then
    return new;
  end if;

  if new.id is distinct from auth.uid() then
    -- Editing someone else's row (RLS already required full-admin status to get here at all).
    -- The super admin's own account is off-limits to every *other* admin, full or not.
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
    or new.verified is distinct from old.verified
    or new.rating is distinct from old.rating
    or new.rating_count is distinct from old.rating_count
    or new.email_verified_at is distinct from old.email_verified_at
    or new.email_verify_token is distinct from old.email_verify_token
    or new.license_active is distinct from old.license_active
    or new.insurance_active is distinct from old.insurance_active
    or new.admin_read_only is distinct from old.admin_read_only
    or new.super_admin is distinct from old.super_admin
    or (new.active and not old.active)
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- Bootstraps the existing production admin account as the protected super admin. A no-op
-- anywhere this account doesn't exist yet (e.g. a fresh local/staging database).
update profiles set super_admin = true where email = 'djsind25@gmail.com';
