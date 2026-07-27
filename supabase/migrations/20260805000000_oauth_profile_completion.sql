-- Google (and later Apple) OAuth sign-in has no way to pass a role or ZIP into
-- raw_user_meta_data the way password signUp() does, so handle_new_user() always creates OAuth
-- profiles as role='customer' with zip='' (its hardcoded default). We treat zip='' as "freshly
-- created via OAuth, never onboarded" and route those profiles to a one-time completion screen
-- (see web/src/auth/CompleteOAuthProfile.jsx) that collects the missing fields and sets the real
-- role via this RPC.
--
-- role/business_name/email_verified_at are all in guard_profile_self_update()'s locked-field list
-- (20260730000000_membership_and_profile_locking.sql), so this follows the same
-- app.bypass_profile_guard escape hatch request_profile_change() already uses. The zip='' check
-- happens on the row *before* the bypass is set, and is re-verified by the WHERE clause implicitly
-- (the row can only match once) — once a profile has a real zip, this function refuses to touch
-- role again, closing off any privilege-escalation route through repeated calls.
create function complete_oauth_profile(
  p_role text, p_name text, p_business_name text, p_zip text, p_phone text, p_sms_consent boolean
) returns profiles
language plpgsql security definer set search_path = public as $$
declare
  v_profile profiles;
begin
  select * into v_profile from profiles where id = auth.uid();
  if v_profile.id is null then
    raise exception 'No profile found.';
  end if;
  if v_profile.zip is distinct from '' then
    raise exception 'Profile has already been completed.';
  end if;
  if p_role not in ('customer', 'hauler') then
    raise exception 'Invalid role.';
  end if;
  if coalesce(trim(p_zip), '') = '' then
    raise exception 'ZIP code is required.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);

  update profiles set
    role = p_role,
    name = coalesce(nullif(p_name, ''), name),
    business_name = case when p_role = 'hauler' then p_business_name else business_name end,
    zip = p_zip,
    phone = nullif(p_phone, ''),
    sms_consent = p_sms_consent,
    sms_consent_at = case when p_sms_consent then now() else sms_consent_at end,
    -- Google has already confirmed this address, so there's no need to run it through the
    -- separate verify_email() token flow (20260715172159_custom_email_verification.sql) that
    -- password signups go through.
    email_verified_at = coalesce(email_verified_at, now())
  where id = auth.uid()
  returning * into v_profile;

  return v_profile;
end;
$$;

grant execute on function complete_oauth_profile(text, text, text, text, text, boolean) to authenticated;
