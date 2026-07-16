-- Lets a signed-in user whose email isn't verified yet trigger another verification email (e.g.
-- the first one landed in spam or the link expired from their inbox view). Regenerates the token
-- rather than resending the old one, so a previously-leaked link can't still be used afterward.
create function resend_verification_email() returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_verified timestamptz;
begin
  select email_verified_at into v_verified from profiles where id = auth.uid();
  if v_verified is not null then
    raise exception 'This account is already verified.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set email_verify_token = encode(extensions.gen_random_bytes(24), 'hex')
    where id = auth.uid();

  perform dispatch_verification_email(auth.uid());
end;
$$;

grant execute on function resend_verification_email() to authenticated;
