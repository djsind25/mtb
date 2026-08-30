-- Suspending an account sent no email at all, and admin-initiated deletion (admin_start_deletion)
-- reused the self-service "we've received your request... you can log back in to cancel" email —
-- the wrong tone entirely for a moderation action nobody asked for. Both now send a professional,
-- Community-Standards-framed notice pointing the recipient at support@mytrashbid.com, distinct
-- from the self-service wording (see send-account-deletion-email's updated header comment).

-- ─── 1. New suspension email dispatcher — mirrors dispatch_account_deletion_email's shape ────────

create function dispatch_account_suspension_email(p_profile_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_base_url text;
  v_key text;
begin
  select value into v_base_url from app_config where key = 'functions_base_url';
  select value into v_key from app_config where key = 'internal_dispatch_key';
  if v_base_url is null or v_base_url = '' then
    return;
  end if;
  perform net.http_post(
    url := v_base_url || '/send-account-suspension-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object('profileId', p_profile_id)
  );
exception when others then
  raise warning 'dispatch_account_suspension_email failed for %: %', p_profile_id, sqlerrm;
end;
$$;
revoke execute on function dispatch_account_suspension_email(uuid) from public;

-- ─── 2. admin_suspend_user — add the email dispatch, otherwise byte-for-byte the current
--    (territory-aware) definition from 20260901000000_territory_admin.sql ────────────────────────

create or replace function admin_suspend_user(p_user_id uuid, p_reason text, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can suspend an account.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role = 'admin' then raise exception 'Admin accounts cannot be suspended here.'; end if;
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
  if v_profile.status = 'suspended' then raise exception 'This account is already suspended.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'suspended', suspended_at = now(), suspended_by_admin_id = auth.uid(), suspension_reason = p_reason
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'suspended', v_profile.status, 'suspended',
    p_reason, null, false, null, null, p_client_user_agent);
  perform dispatch_account_suspension_email(p_user_id);
end;
$$;

-- ─── 3. admin_start_deletion — 'requested' -> 'requested_admin', otherwise byte-for-byte the
--    current (territory-aware) definition from 20260901000000_territory_admin.sql ────────────────

create or replace function admin_start_deletion(
  p_user_id uuid, p_reason text, p_override boolean default false, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype; v_blockers jsonb;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can start a deletion.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role = 'admin' then raise exception 'Admin accounts are not managed through this flow.'; end if;
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
  if v_profile.status = 'deletion_requested' then raise exception 'DELETION_ALREADY_REQUESTED: Already pending.'; end if;
  if v_profile.status in ('anonymized', 'deleted') then raise exception 'ACCOUNT_ALREADY_ANONYMIZED: Already closed.'; end if;

  select jsonb_agg(to_jsonb(b)) into v_blockers from check_account_deletion_blockers(p_user_id) b;
  if v_blockers is not null and jsonb_array_length(v_blockers) > 0 and not p_override then
    raise exception 'ACCOUNT_DELETION_BLOCKED: This account has open items — resolve them, or override with a reason.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'deletion_requested', deletion_requested_at = now(), deletion_reason = p_reason,
    deletion_scheduled_for = now() + interval '30 days'
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'deletion_started_admin', v_profile.status, 'deletion_requested',
    p_reason, v_blockers, coalesce(p_override, false) and v_blockers is not null, now() + interval '30 days', null, p_client_user_agent);
  perform dispatch_account_deletion_email(p_user_id, 'requested_admin');
end;
$$;
