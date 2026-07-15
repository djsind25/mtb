-- Profile creation used to happen client-side, right after auth.signUp() returned a session.
-- That only ever worked because local dev has email confirmation disabled, so signup returned a
-- session immediately. Now that Cloud requires confirmation, signUp() never returns a session at
-- signup time — the client code always hit its "check your email" branch and returned before ever
-- inserting the profile row, so confirmed accounts were stuck with no profile. Move profile
-- creation into a trigger on auth.users so it happens regardless of confirmation timing.
--
-- Role is deliberately clamped to customer/hauler here — admin accounts must never be creatable
-- via signup metadata a client controls, matching the existing profiles_insert_own restriction.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
begin
  v_role := new.raw_user_meta_data->>'role';
  if v_role not in ('customer', 'hauler') then
    v_role := 'customer';
  end if;

  insert into profiles (id, role, email, name, business_name, zip)
  values (
    new.id,
    v_role,
    new.email,
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'business_name',
    coalesce(new.raw_user_meta_data->>'zip', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
