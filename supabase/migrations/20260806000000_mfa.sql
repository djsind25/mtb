-- Risk-tiered, login-aware MFA — Phase 1: admin mandatory TOTP + server-enforced step-up re-auth
-- on the app's two real admin money/account-status actions (refund, ban).
--
-- Login-MFA and step-up re-auth both ride on Supabase's own AAL mechanism: a successful
-- auth.mfa.challenge()+verify() bumps the caller's JWT to carry aal: "aal2" — no custom "proof
-- token" needed. Server-side enforcement is just checking auth.jwt()->>'aal', the standard
-- Supabase step-up pattern. Source of truth for "is this user enrolled" is Supabase's own
-- auth.mfa_factors table — no duplicate profiles.mfa_enrolled column to keep in sync.

create function user_has_verified_mfa(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.mfa_factors where user_id = p_user_id and status = 'verified');
$$;
grant execute on function user_has_verified_mfa(uuid) to authenticated;

create function require_aal2() returns void
  language plpgsql stable as $$
begin
  if coalesce(auth.jwt()->>'aal', 'aal1') is distinct from 'aal2' then
    raise exception 'Step-up verification required.';
  end if;
end;
$$;

-- ─── Recovery codes — Supabase's TOTP API has no built-in backup-codes concept, this is custom.
-- No RLS policies granted at all: these tables are only ever touched through the RPCs below
-- (security definer, run as the migration owner), never directly by an authenticated client.
create table mfa_recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
alter table mfa_recovery_codes enable row level security;

create table mfa_admin_recovery_log (
  id              uuid primary key default gen_random_uuid(),
  target_user_id  uuid not null,
  admin_id        uuid not null,
  reason          text,
  performed_at    timestamptz not null default now()
);
alter table mfa_admin_recovery_log enable row level security;
create policy mfa_admin_recovery_log_select on mfa_admin_recovery_log for select using (is_admin());
grant select on mfa_admin_recovery_log to authenticated;

-- Called right after enrollment's own verify() succeeds (session is already aal2 at that point —
-- require_aal2() here is defense in depth, not the primary gate). Regenerating replaces any
-- still-unused set from a prior enrollment, so there's never more than one active batch of codes.
create function generate_mfa_recovery_codes() returns text[]
  language plpgsql security definer set search_path = public as $$
declare
  v_codes text[] := '{}';
  v_code text;
  i int;
begin
  if not user_has_verified_mfa(auth.uid()) then
    raise exception 'Enroll a verified authenticator before generating recovery codes.';
  end if;
  perform require_aal2();

  delete from mfa_recovery_codes where user_id = auth.uid() and used_at is null;

  for i in 1..10 loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 4)) || '-'
      || upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 4));
    insert into mfa_recovery_codes (user_id, code_hash)
      values (auth.uid(), extensions.crypt(v_code, extensions.gen_salt('bf')));
    v_codes := array_append(v_codes, v_code);
  end loop;

  return v_codes;
end;
$$;
grant execute on function generate_mfa_recovery_codes() to authenticated;

-- A recovery code only unlocks login — it does NOT bump the session to aal2 the way a real TOTP
-- verify() does (there's no Supabase mechanism for a custom RPC to do that). So this also strips
-- the user's existing factor(s), forcing immediate re-enrollment right after login: enrolling a
-- fresh factor's own verify() call is what naturally re-establishes aal2. This also means a lost
-- device can't be used again even if somehow recovered later.
create function redeem_mfa_recovery_code(p_code text) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  v_code_id uuid;
begin
  select id into v_code_id from mfa_recovery_codes
    where user_id = auth.uid() and used_at is null and code_hash = extensions.crypt(p_code, code_hash)
    limit 1;
  if v_code_id is null then
    return false;
  end if;

  update mfa_recovery_codes set used_at = now() where id = v_code_id;
  delete from auth.mfa_factors where user_id = auth.uid();

  return true;
end;
$$;
grant execute on function redeem_mfa_recovery_code(text) to authenticated;

-- Admin-assisted recovery for a user who has lost both their device and their codes. The admin
-- performing this must themselves be freshly step-up-verified (require_aal2()) — otherwise a
-- hijacked admin session could be used to strip a target's MFA as an attack vector. The super
-- admin's own MFA can only ever be reset by the super admin themselves, matching the protection
-- guard_profile_self_update() already gives their account against other admins.
create function admin_reset_user_mfa(p_user_id uuid, p_reason text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_target_super_admin boolean;
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can reset another user''s MFA.';
  end if;
  perform require_aal2();

  select super_admin into v_target_super_admin from profiles where id = p_user_id;
  if v_target_super_admin and p_user_id is distinct from auth.uid() then
    raise exception 'The super admin account''s MFA can only be reset by the super admin themselves.';
  end if;

  delete from auth.mfa_factors where user_id = p_user_id;
  delete from mfa_recovery_codes where user_id = p_user_id;

  insert into mfa_admin_recovery_log (target_user_id, admin_id, reason)
    values (p_user_id, auth.uid(), p_reason);
end;
$$;
grant execute on function admin_reset_user_mfa(uuid, text) to authenticated;

-- ─── Step-up enforcement on the two real admin money/status actions ───────────────────────────

-- Same claim_cancellation_for_refund as 20260725000000_code_review_fixes.sql:19-31, plus a
-- require_aal2() check right alongside the existing is_full_admin() check — this is what actually
-- gates the "Refund" button server-side; the client-side StepUpChallenge modal is UX, not the
-- security boundary.
create or replace function claim_cancellation_for_refund(p_request_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve cancellation requests';
  end if;
  perform require_aal2();
  update cancellation_requests set refund_in_progress = true
    where id = p_request_id and status = 'pending' and refund_in_progress = false;
  if not found then
    raise exception 'This request is already being processed or has been resolved.';
  end if;
end;
$$;

-- Replaces the plain client-side `profiles` table update UserRow.jsx used for deactivate/
-- reactivate ("ban") — a real server-enforced chokepoint instead, so step-up can actually be
-- checked before the write goes through. guard_profile_self_update()'s existing is_full_admin()
-- bypass and super-admin protection clause both still apply underneath this as before.
create function admin_set_user_active(p_user_id uuid, p_active boolean) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can change an account''s status.';
  end if;
  perform require_aal2();

  update profiles set active = p_active, deactivated_at = case when p_active then null else now() end
    where id = p_user_id;
end;
$$;
grant execute on function admin_set_user_active(uuid, boolean) to authenticated;
