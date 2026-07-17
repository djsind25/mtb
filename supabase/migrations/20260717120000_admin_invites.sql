-- MyTrashBid — invite new admins by email
--
-- Admin accounts today can only be created by hand via the Supabase SQL editor (see README).
-- Lets the super admin invite someone by email instead: they get a link, pick a password, and
-- their account is created directly as an admin (full or view-only, the super admin's choice) —
-- no separate manual promotion step. Same "unguessable token is the credential" trust model as
-- the existing email-verification flow (verify_email()).

-- Fixes a latent bug found while building the invite-acceptance flow below: `v_role not in
-- ('customer', 'hauler')` only clamps a *recognized-but-wrong* role — SQL's three-valued logic
-- means a *missing* role key (v_role is null) makes the whole `not in` expression null, not true,
-- so the clamp never fires and the insert violates profiles.role's not-null constraint instead.
-- Every existing call site happens to always pass an explicit role, which is why this never
-- surfaced before; the invite-accept signup deliberately doesn't need to reason about that.
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_profile_id uuid;
begin
  v_role := new.raw_user_meta_data->>'role';
  if v_role is null or v_role not in ('customer', 'hauler') then
    v_role := 'customer';
  end if;

  insert into profiles (id, role, email, name, business_name, zip, email_verify_token)
  values (
    new.id,
    v_role,
    new.email,
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'business_name',
    coalesce(new.raw_user_meta_data->>'zip', ''),
    encode(extensions.gen_random_bytes(24), 'hex')
  )
  on conflict (id) do nothing
  returning id into v_profile_id;

  if v_profile_id is not null then
    perform dispatch_verification_email(v_profile_id);
  end if;

  return new;
end;
$$;

create table admin_invites (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  admin_read_only  boolean not null default false,
  token            text not null unique,
  invited_by       uuid not null references profiles(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '7 days',
  accepted_at      timestamptz
);

alter table admin_invites enable row level security;

-- Any admin (including view-only) can see invite history — informational, matches the
-- is_admin()-gates-reads pattern used everywhere else. Only the super admin can create/cancel one
-- (enforced inside the RPCs below, not via RLS, since there's no client-facing insert/update at all).
create policy admin_invites_select on admin_invites for select using (is_admin());
grant select on admin_invites to authenticated;

create function is_super_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and super_admin);
  $$;

create function dispatch_admin_invite_email(p_invite_id uuid) returns void
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
      url := v_base_url || '/send-admin-invite',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('inviteId', p_invite_id)
    );
  exception when others then
    raise warning 'dispatch_admin_invite_email failed for %: %', p_invite_id, sqlerrm;
  end;
  $$;

create function create_admin_invite(p_email text, p_admin_read_only boolean default false)
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

  insert into admin_invites (email, admin_read_only, token, invited_by)
  values (v_email, p_admin_read_only, encode(extensions.gen_random_bytes(24), 'hex'), auth.uid())
  returning id into v_invite_id;

  perform dispatch_admin_invite_email(v_invite_id);

  return v_invite_id;
end;
$$;

grant execute on function create_admin_invite(text, boolean) to authenticated;

create function cancel_admin_invite(p_invite_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then
    raise exception 'Only the super admin can cancel an invite';
  end if;
  delete from admin_invites where id = p_invite_id and accepted_at is null;
end;
$$;

grant execute on function cancel_admin_invite(uuid) to authenticated;

-- Public: the invite-acceptance page needs to show the invited email/admin type before the
-- invitee has any session at all — same "no auth, token is the credential" model as verify_email.
create function check_admin_invite(p_token text)
returns table(email text, admin_read_only boolean)
language sql stable security definer set search_path = public as $$
  select email, admin_read_only from admin_invites
  where token = p_token and accepted_at is null and expires_at > now();
$$;

grant execute on function check_admin_invite(text) to anon, authenticated;

-- Called right after the invitee's own supabase.auth.signUp() creates their (safely defaulted
-- to role='customer') profile row — promotes that same row to admin. The role = 'customer' check
-- is a sanity guard: create_admin_invite already refuses to issue an invite for an email that has
-- any existing account, so this should only ever match a profile created moments ago by this
-- exact flow.
create function accept_admin_invite(p_token text) returns boolean
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
  update profiles set role = 'admin', admin_read_only = v_invite.admin_read_only where id = v_profile_id;

  update admin_invites set accepted_at = now() where id = v_invite.id;

  return true;
end;
$$;

grant execute on function accept_admin_invite(text) to anon, authenticated;
