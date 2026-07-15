-- Decouples "logged in" from "verified" for customer signups. Previously enable_confirmations
-- gated login itself (blocking the user entirely until they clicked a link) — this switches that
-- off (see config.toml) so signup logs the user in immediately, and adds a separate, custom
-- verification flow that instead gates whether a job POST is visible to haulers: new jobs from an
-- unverified customer are created as 'pending_verification' (excluded from
-- list_open_jobs_for_hauler(), which only ever returns status = 'open') and automatically flip to
-- 'open' — with a fresh expiry window starting from that moment, not from creation — the instant
-- the customer verifies.

alter table profiles
  add column email_verified_at timestamptz,
  add column email_verify_token text;

-- expires_at is no longer computable at insert time for a pending_verification job (there's
-- nothing to count down yet — the window starts once verify_email() actually posts it), so it
-- can't stay NOT NULL.
alter table jobs alter column expires_at drop not null;

alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check
  check (status in ('open', 'booked', 'pending_verification'));

-- Fires an async, best-effort HTTP call to the send-verification-email Edge Function — same
-- fire-and-forget pattern as dispatch_notification_email, so a slow/failing call never blocks
-- the signup transaction.
create function dispatch_verification_email(p_profile_id uuid) returns void
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
      url := v_base_url || '/send-verification-email',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('profileId', p_profile_id)
    );
  exception when others then
    raise warning 'dispatch_verification_email failed for %: %', p_profile_id, sqlerrm;
  end;
  $$;

create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_profile_id uuid;
begin
  v_role := new.raw_user_meta_data->>'role';
  if v_role not in ('customer', 'hauler') then
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

create or replace function set_job_expiry() returns trigger
  language plpgsql as $$
declare
  v_days int;
  v_verified boolean;
begin
  select (email_verified_at is not null) into v_verified from profiles where id = new.customer_id;

  if not coalesce(v_verified, false) then
    new.status := 'pending_verification';
    new.expires_at := null;
  else
    v_days := case when new.service_type = 'rental'
      then app_config_numeric('rental_live_window_days')::int
      else app_config_numeric('live_window_days')::int
    end;
    new.expires_at := new.created_at + make_interval(days => v_days);
  end if;

  if new.zip is not null then
    select lat, lng into new.lat, new.lng from zip_geo where zip = trim(new.zip);
  end if;
  return new;
end;
$$;

-- Called from the client (no auth required — the unguessable token itself is the credential,
-- same trust model as Supabase's own confirmation links) once the customer clicks the emailed
-- verification link. Flips their profile to verified and any pending posts to live.
create function verify_email(p_token text) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  v_profile_id uuid;
begin
  select id into v_profile_id from profiles
    where email_verify_token = p_token and email_verified_at is null;
  if v_profile_id is null then
    return false;
  end if;

  update profiles set email_verified_at = now(), email_verify_token = null where id = v_profile_id;

  update jobs set
    status = 'open',
    expires_at = now() + make_interval(days => (case when service_type = 'rental'
      then app_config_numeric('rental_live_window_days')::int
      else app_config_numeric('live_window_days')::int
    end))
  where customer_id = v_profile_id and status = 'pending_verification';

  return true;
end;
$$;

grant execute on function verify_email(text) to anon, authenticated;
