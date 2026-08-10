-- MyTrashBid — 2FA method expansion: passkey (WebAuthn) + email code, alongside the existing TOTP.
--
-- No SMS — deliberately excluded (SIM-swap risk, TCPA/10DLC overhead).
--
-- ── Passkey ─────────────────────────────────────────────────────────────────────────────────────
-- Uses Supabase Auth's own native WebAuthn MFA support (auth.mfa.webauthn on the client — see
-- lib/mfa.js). It enrolls into the exact same auth.mfa_factors table TOTP does, just with
-- factor_type = 'webauthn', so user_has_verified_mfa() below already covers it with zero schema
-- changes. The only other requirement is enabling [auth.mfa.web_authn] + [auth.webauthn] in
-- config.toml and pushing it (`supabase config push`) — see that file for the per-environment
-- rp_id, and the session's final report for exactly what still needs verifying live.
--
-- ── Email code ──────────────────────────────────────────────────────────────────────────────────
-- Supabase has no native "email" MFA factor type, so this is genuinely custom — and critically, it
-- can NOT make GoTrue stamp a session's JWT aal claim to "aal2" the way a real auth.mfa.verify()
-- call does. That means an email-code factor can satisfy user_has_verified_mfa() (a pure enrollment
-- check — this is what the hauler bid-gate RLS policy uses, and it's already how TOTP/webauthn are
-- checked) but it can NEVER satisfy require_aal2() (a live-session check for step-up re-auth on
-- payout/email/phone/passcode changes and admin actions). Decision from this session: email code is
-- scoped to the bid-gate only. A hauler whose only method is email code still falls through to
-- StepUpChallenge's existing password fallback for sensitive actions, exactly like an unenrolled
-- account does today — nothing about require_aal2() or its callers changes here.

-- ── email_mfa_factors: same shape/security posture as mfa_recovery_codes — RPC-only, no direct
-- grants. code_hash never stores the plaintext code; the plaintext only ever exists transiently in
-- start_email_mfa_enrollment()'s local variable and the one dispatch call that emails it.
create table email_mfa_factors (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  status           text not null default 'unverified' check (status in ('unverified', 'verified')),
  code_hash        text,
  code_expires_at  timestamptz,
  attempts         int not null default 0,
  verified_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index email_mfa_factors_user_id_idx on email_mfa_factors (user_id);
alter table email_mfa_factors enable row level security;
-- Scoped to own rows only, and code_hash is a bcrypt hash (never the plaintext code) — safe for
-- the client to read directly so the settings UI can show enrollment status without an extra RPC.
create policy email_mfa_factors_select on email_mfa_factors for select using (user_id = auth.uid());
grant select on email_mfa_factors to authenticated;

-- user_has_verified_mfa() is the single source of truth for "is this account MFA-enrolled" —
-- extends it to also recognize a verified email factor, alongside Supabase's own auth.mfa_factors.
create or replace function user_has_verified_mfa(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.mfa_factors where user_id = p_user_id and status = 'verified')
    or exists (select 1 from email_mfa_factors where user_id = p_user_id and status = 'verified');
$$;

-- Lets the client check its own MFA status in one round trip (used by the hauler bid-gate
-- pre-check in HaulerDashboard.jsx) without needing a separate email_mfa_factors read policy.
create function user_has_verified_mfa_self() returns boolean
  language sql stable security definer set search_path = public as $$
  select user_has_verified_mfa(auth.uid());
$$;
grant execute on function user_has_verified_mfa_self() to authenticated;

-- Fire-and-forget dispatch to send-mfa-email-code, mirroring dispatch_notification_email's
-- pattern exactly. Deliberately NOT routed through the notifications table / send-notification —
-- that pipeline is gated on the recipient's notification_prefs, and a security code must always
-- send regardless of what a user has opted out of.
create function dispatch_email_mfa_code(p_user_id uuid, p_code text) returns void
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
      url := v_base_url || '/send-mfa-email-code',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('userId', p_user_id, 'code', p_code)
    );
  exception when others then
    raise warning 'dispatch_email_mfa_code failed for %: %', p_user_id, sqlerrm;
  end;
  $$;

-- Generates and emails a fresh 6-digit code. A short cooldown (60s) on a still-pending unverified
-- request avoids accidental double-sends from a double-click; any prior unverified request is
-- replaced outright once that cooldown has passed, same "clean slate" behavior MfaEnrollment.jsx
-- already gives TOTP (it unenrolls an abandoned unverified factor before starting a fresh one).
create function start_email_mfa_enrollment() returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_email_verified_at timestamptz;
  v_code text;
  v_recent_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select email, email_verified_at into v_email, v_email_verified_at from profiles where id = auth.uid();
  if v_email is null then
    raise exception 'No email on file for this account.';
  end if;
  if v_email_verified_at is null then
    raise exception 'Verify your email address before setting up email-code two-factor authentication.';
  end if;
  if exists (select 1 from email_mfa_factors where user_id = auth.uid() and status = 'verified') then
    raise exception 'Email code is already set up — remove it first to reissue.';
  end if;

  select id into v_recent_id from email_mfa_factors
    where user_id = auth.uid() and status = 'unverified' and created_at > now() - interval '60 seconds';
  if v_recent_id is not null then
    raise exception 'A code was just sent — check your inbox before requesting another.';
  end if;

  delete from email_mfa_factors where user_id = auth.uid() and status = 'unverified';

  v_code := lpad((floor(random() * 1000000))::text, 6, '0');
  insert into email_mfa_factors (user_id, code_hash, code_expires_at)
    values (auth.uid(), extensions.crypt(v_code, extensions.gen_salt('bf')), now() + interval '10 minutes');

  perform dispatch_email_mfa_code(auth.uid(), v_code);
end;
$$;
grant execute on function start_email_mfa_enrollment() to authenticated;

-- Pure mechanics, no aal2/enrollment checks of its own — both public entry points below are
-- responsible for their own gating before calling this.
create function generate_recovery_codes_for(p_user_id uuid) returns text[]
  language plpgsql security definer set search_path = public as $$
declare
  v_codes text[] := '{}';
  v_code text;
  i int;
begin
  delete from mfa_recovery_codes where user_id = p_user_id and used_at is null;
  for i in 1..10 loop
    v_code := upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 4)) || '-'
      || upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 4));
    insert into mfa_recovery_codes (user_id, code_hash)
      values (p_user_id, extensions.crypt(v_code, extensions.gen_salt('bf')));
    v_codes := array_append(v_codes, v_code);
  end loop;
  return v_codes;
end;
$$;

-- Unchanged behavior for existing callers (TOTP/webauthn enrollment, manual regeneration from
-- settings) — still requires a real aal2 session, now just delegating the actual code-minting to
-- the shared helper above instead of duplicating it.
create or replace function generate_mfa_recovery_codes() returns text[]
  language plpgsql security definer set search_path = public as $$
begin
  if not user_has_verified_mfa(auth.uid()) then
    raise exception 'Enroll a verified authenticator before generating recovery codes.';
  end if;
  perform require_aal2();
  return generate_recovery_codes_for(auth.uid());
end;
$$;

-- Verifies the code and, on success, mints recovery codes in the same call — email verification
-- can never produce a real aal2 session, so it can't go through generate_mfa_recovery_codes()'s
-- normal require_aal2() gate. Its own successful code match is the equivalent proof of "this is
-- really them" for this weaker method, matching the "bid-gate only" scope decision above.
create function verify_email_mfa_code(p_code text) returns text[]
  language plpgsql security definer set search_path = public as $$
declare
  v_factor email_mfa_factors%rowtype;
begin
  select * into v_factor from email_mfa_factors
    where user_id = auth.uid() and status = 'unverified'
    order by created_at desc limit 1
    for update;
  if v_factor.id is null then
    raise exception 'No pending email code — request a new one.';
  end if;
  if v_factor.code_expires_at < now() then
    delete from email_mfa_factors where id = v_factor.id;
    raise exception 'That code has expired — request a new one.';
  end if;
  if v_factor.attempts >= 5 then
    delete from email_mfa_factors where id = v_factor.id;
    raise exception 'Too many incorrect attempts — request a new code.';
  end if;
  if v_factor.code_hash is distinct from extensions.crypt(p_code, v_factor.code_hash) then
    update email_mfa_factors set attempts = attempts + 1 where id = v_factor.id;
    raise exception 'That code didn''t match — try again.';
  end if;

  update email_mfa_factors set status = 'verified', verified_at = now(), code_hash = null
    where id = v_factor.id;

  return generate_recovery_codes_for(auth.uid());
end;
$$;
grant execute on function verify_email_mfa_code(text) to authenticated;

create function remove_email_mfa_factor() returns void
  language plpgsql security definer set search_path = public as $$
begin
  delete from email_mfa_factors where user_id = auth.uid() and status = 'verified';
end;
$$;
grant execute on function remove_email_mfa_factor() to authenticated;

-- Admin-assisted recovery now also strips a verified email factor, so a full MFA reset genuinely
-- clears every method, not just the two backed by auth.mfa_factors.
create or replace function admin_reset_user_mfa(p_user_id uuid, p_reason text default null) returns void
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
  delete from email_mfa_factors where user_id = p_user_id;

  insert into mfa_admin_recovery_log (target_user_id, admin_id, reason)
    values (p_user_id, auth.uid(), p_reason);
end;
$$;

-- ── Admin-configurable allowed methods ──────────────────────────────────────────────────────────
-- Single-row config, same "id boolean primary key default true" singleton pattern as
-- platform_fee_config. Any admin (including view-only) can read it; only a super admin can change
-- it, matching money-policy limits — this shapes real security posture, not just money, so no
-- allow_admin_edits delegation toggle like the platform-fee rate has.
create table security_policy_config (
  id                  boolean primary key default true check (id),
  allowed_mfa_methods text[] not null default array['passkey', 'totp', 'email']
);
insert into security_policy_config (id) values (true);
alter table security_policy_config enable row level security;
create policy security_policy_config_select on security_policy_config for select using (is_admin());
grant select on security_policy_config to authenticated;

create function set_allowed_mfa_methods(p_methods text[]) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not coalesce((select super_admin from profiles where id = auth.uid()), false) then
    raise exception 'Only the super admin can change allowed 2FA methods.';
  end if;
  if p_methods <@ array['passkey', 'totp', 'email']::text[] and array_length(p_methods, 1) > 0 then
    update security_policy_config set allowed_mfa_methods = p_methods where id = true;
  else
    raise exception 'Invalid method list — only passkey, totp, and email are supported (no SMS).';
  end if;
end;
$$;
grant execute on function set_allowed_mfa_methods(text[]) to authenticated;
