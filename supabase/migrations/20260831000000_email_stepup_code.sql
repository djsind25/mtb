-- MyTrashBid — "email me a code instead" for step-up re-auth on passcode changes.
--
-- Separate from email_mfa_factors (20260829000000_2fa_additional_methods.sql) on purpose: that
-- table is a persistent MFA *enrollment* (verifying it mints recovery codes and satisfies the
-- hauler bid-gate going forward). This is a transient, single-use verification — proving control
-- of the account's email right now, to stand in for re-typing the current passcode. No enrollment
-- state, no recovery codes, nothing persists past one successful (or expired/abandoned) code.
--
-- Scoped deliberately to password change only (see StepUpChallenge.jsx's allowEmailFallback prop,
-- opted into only by AccountTab's submitPasswordChange) — NOT offered for account
-- deactivation/deletion, whose RPCs (deactivate_own_account, request_own_account_deletion) take
-- the real current passcode as a parameter and re-check it server-side; there's no passcode value
-- to hand them after an email-code verification, so wiring this in there would just trade one
-- real check for a dead end. auth.updateUser({ password }) needs no such parameter, so email
-- verification alone is sufficient proof for that specific call.
create table email_stepup_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);
create index email_stepup_codes_user_id_idx on email_stepup_codes (user_id);
alter table email_stepup_codes enable row level security;
-- RPC-only, no direct grants — same posture as mfa_recovery_codes/email_mfa_factors.

create function start_email_stepup_code() returns void
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
  if v_email is null or v_email_verified_at is null then
    raise exception 'Verify your email address before using this option.';
  end if;

  select id into v_recent_id from email_stepup_codes
    where user_id = auth.uid() and created_at > now() - interval '60 seconds';
  if v_recent_id is not null then
    raise exception 'A code was just sent — check your inbox before requesting another.';
  end if;

  delete from email_stepup_codes where user_id = auth.uid();

  v_code := lpad((floor(random() * 1000000))::text, 6, '0');
  insert into email_stepup_codes (user_id, code_hash, expires_at)
    values (auth.uid(), extensions.crypt(v_code, extensions.gen_salt('bf')), now() + interval '10 minutes');

  perform dispatch_email_mfa_code(auth.uid(), v_code);
end;
$$;
grant execute on function start_email_stepup_code() to authenticated;

-- Returns boolean rather than raising on a wrong code, same shape as redeem_mfa_recovery_code —
-- callers show a "didn't match" message and let the user retry rather than losing their place.
create function verify_email_stepup_code(p_code text) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  v_row email_stepup_codes%rowtype;
begin
  select * into v_row from email_stepup_codes where user_id = auth.uid() order by created_at desc limit 1 for update;
  if v_row.id is null or v_row.expires_at < now() or v_row.attempts >= 5 then
    return false;
  end if;
  if v_row.code_hash is distinct from extensions.crypt(p_code, v_row.code_hash) then
    update email_stepup_codes set attempts = attempts + 1 where id = v_row.id;
    return false;
  end if;
  delete from email_stepup_codes where user_id = auth.uid();
  return true;
end;
$$;
grant execute on function verify_email_stepup_code(text) to authenticated;
