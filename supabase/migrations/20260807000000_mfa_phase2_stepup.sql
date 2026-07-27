-- MFA Phase 2: universal step-up re-auth on sensitive account changes (all users, not just admin).
--
-- Password/email changes go through Supabase's own auth.updateUser() API, not our RPCs — but
-- GoTrue already enforces aal2 there natively once a user has a verified MFA factor (confirmed
-- empirically: attempting updateUser({password}) at aal1 with a factor enrolled returns
-- "AAL2 session is required to update email or password when MFA is enabled." with a 401). So no
-- migration changes are needed for those two — the client just needs a StepUpChallenge in front of
-- the button so the user gets a clean code-entry flow instead of a raw 401.
--
-- Self-deactivation is different: it's our own write, so we make it genuinely server-enforced for
-- everyone, not just MFA-enrolled users. If a verified TOTP factor exists, require aal2 (same as
-- Phase 1). Otherwise, if the account has a password at all, verify it directly against
-- auth.users.encrypted_password — this is real protection against a hijacked session that doesn't
-- know the password, not just a client-side speedbump. A pure-OAuth account with no password and
-- no MFA factor has nothing left to check, so it proceeds — there is no secondary factor to step
-- up to in that case.
create function deactivate_own_account(p_password text default null) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_encrypted text;
begin
  if user_has_verified_mfa(auth.uid()) then
    perform require_aal2();
  else
    select encrypted_password into v_encrypted from auth.users where id = auth.uid();
    if v_encrypted is not null then
      if p_password is null or v_encrypted is distinct from extensions.crypt(p_password, v_encrypted) then
        raise exception 'Incorrect passcode.';
      end if;
    end if;
  end if;

  update profiles set active = false, deactivated_at = now() where id = auth.uid();
end;
$$;
grant execute on function deactivate_own_account(text) to authenticated;
