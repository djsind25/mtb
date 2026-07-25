-- Membership tiers (infrastructure only — every tier currently resolves to the same numbers,
-- see web/src/membership.js) and profile-edit locking for haulers.
--
-- ── Part 1: membership tiers ─────────────────────────────────────────────────────────────────
-- membership_tier lives on profiles (admin-editable only); actual entitlement VALUES are defined
-- twice on purpose — once here (server-authoritative, since RPCs can't trust a client-supplied
-- rate/radius) and once in web/src/membership.js (client-facing, for the Account tab display and
-- as the canonical definition a human edits first). Keep the two in sync — see the comment atop
-- that file. Today every branch of every function below returns the same number for every tier,
-- so this changes no observable behavior; it only gives future tier-specific values somewhere to
-- plug into.

alter table profiles add column membership_tier text not null default 'free'
  check (membership_tier in ('free', 'pro', 'premium'));

create function membership_max_radius_mi(p_tier text) returns numeric
language sql immutable as $$
  select case p_tier
    when 'pro' then 50
    when 'premium' then 50
    else 50
  end;
$$;

create function membership_commission_rate(p_tier text) returns numeric
language sql immutable as $$
  select case p_tier
    when 'pro' then 0.10
    when 'premium' then 0.10
    else 0.10
  end;
$$;

-- null = unlimited.
create function membership_max_bids_per_month(p_tier text) returns int
language sql immutable as $$
  select case p_tier
    when 'pro' then null::int
    when 'premium' then null::int
    else null::int
  end;
$$;

-- Wiring point 1/2: the browse-jobs radius filter now reads the hauler's own tier entitlement
-- instead of the flat app_config_numeric('max_radius_mi') every hauler shared before. Only the
-- v_radius line changed from the version in 20260729000000_hauler_ux_fixes.sql.
create or replace function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  created_at timestamptz, expires_at timestamptz, bid_count bigint, distance_mi numeric,
  photo_count bigint, city text, state text
)
language plpgsql security definer set search_path = public as $$
declare
  v_hauler profiles%rowtype;
  v_radius numeric;
begin
  select * into v_hauler from profiles where profiles.id = auth.uid();
  if v_hauler.id is null or v_hauler.role <> 'hauler' then
    raise exception 'Only hauler accounts can browse open jobs';
  end if;
  if not v_hauler.active then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  v_radius := membership_max_radius_mi(v_hauler.membership_tier);

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode, j.created_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count,
      z.city, z.state
    from jobs j
    left join zip_geo z on z.zip = j.zip
    where j.status = 'open' and j.expires_at > now()
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;
grant execute on function list_open_jobs_for_hauler() to authenticated;

-- public_profiles gains membership_tier so a customer viewing a bid can resolve the bidding
-- hauler's commission-rate entitlement (BidRow.jsx's deposit-preview math, wiring point 2/2).
create or replace view public_profiles as
  select id, role, name, business_name, avatar, verified, rating, rating_count,
    license_active, insurance_active, created_at, membership_tier
  from profiles;

-- Monthly bid cap check, added to the existing bids_insert policy alongside the license/insurance
-- gate. Counted live from the bids table (no stored counter to keep in sync/reset) — every tier's
-- cap is null today, so this subquery never actually blocks anyone yet.
drop policy bids_insert on bids;
create policy bids_insert on bids for insert with check (
  hauler_id = auth.uid()
  and is_active_user()
  and exists (
    select 1 from profiles
    where profiles.id = auth.uid() and profiles.role = 'hauler'
      and profiles.license_active and profiles.insurance_active
  )
  and job_is_open_for_bid(bids.job_id)
  and (
    (select membership_max_bids_per_month(membership_tier) from profiles where id = auth.uid()) is null
    or (select count(*) from bids b2 where b2.hauler_id = auth.uid()
         and date_trunc('month', b2.created_at) = date_trunc('month', now()))
       < (select membership_max_bids_per_month(membership_tier) from profiles where id = auth.uid())
  )
);

-- ── Part 2: profile-edit locking ─────────────────────────────────────────────────────────────
-- New freely-editable field (bio) and new change-request-gated vetting fields. business_name
-- already existed; license/insurance were booleans only (license_active/insurance_active) with
-- no actual number/provider text on file until now.
alter table profiles
  add column bio text,
  add column license_number text,
  add column insurance_info text,
  add column business_registration_number text;

-- One row per requested field change — lets the admin queue and the hauler's own "pending
-- review" state stay a simple select, and lets each field be approved/denied independently
-- (e.g. a business-name change can be approved while a license-number change on the same hauler
-- is still pending).
create table profile_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  hauler_id          uuid not null references profiles(id) on delete cascade,
  field              text not null check (field in ('business_name', 'license_number', 'insurance_info', 'business_registration_number')),
  old_value          text,
  requested_value    text not null,
  reason             text,
  status             text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  resolved_by        uuid references profiles(id),
  admin_note         text
);

alter table profile_change_requests enable row level security;
create policy profile_change_requests_select on profile_change_requests for select using (
  hauler_id = auth.uid() or is_admin()
);
-- No insert/update policy — same shape as hauler_documents: every write goes through the two
-- security-definer RPCs below, since a hauler and an admin each need to touch columns (status,
-- resolved_by) the other must not be able to set directly.
grant select on profile_change_requests to authenticated, service_role;

-- Admin-visible audit trail of service-ZIP changes — logged automatically regardless of which
-- path changed the zip (self-service save or an admin edit), since it's a plain AFTER UPDATE
-- trigger rather than something wired into one specific save button.
create table profile_zip_history (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  old_zip     text,
  new_zip     text,
  changed_at  timestamptz not null default now()
);

alter table profile_zip_history enable row level security;
create policy profile_zip_history_select on profile_zip_history for select using (is_admin());
grant select on profile_zip_history to authenticated, service_role;

create function log_profile_zip_change() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.zip is distinct from old.zip then
    insert into profile_zip_history (profile_id, old_zip, new_zip) values (old.id, old.zip, new.zip);
  end if;
  return new;
end;
$$;

create trigger profiles_log_zip_change after update on profiles
  for each row execute function log_profile_zip_change();

-- Extends the existing self-update guard: business_name and the three new vetting-credential
-- fields move from freely-editable to change-request-only (a plain client update to any of them
-- is now rejected the same way license_active/verified already were); membership_tier joins the
-- admin-only fields. bio/license_number/insurance_info/business_registration_number aren't all
-- listed here individually beyond the three vetting ones — bio stays freely editable like name/
-- phone/zip always have been, it's just a new column with no special guard needed.
create or replace function guard_profile_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true' then
    return new;
  end if;

  if new.id is distinct from auth.uid() then
    if old.super_admin and (
      new.active is distinct from old.active
      or new.role is distinct from old.role
      or new.admin_read_only is distinct from old.admin_read_only
      or new.super_admin is distinct from old.super_admin
    ) then
      raise exception 'The super admin account cannot be deactivated or modified by another admin.';
    end if;
    return new;
  end if;

  if is_full_admin() then
    return new;
  end if;

  if new.role is distinct from old.role
    or new.verified is distinct from old.verified
    or new.rating is distinct from old.rating
    or new.rating_count is distinct from old.rating_count
    or new.email_verified_at is distinct from old.email_verified_at
    or new.email_verify_token is distinct from old.email_verify_token
    or new.license_active is distinct from old.license_active
    or new.insurance_active is distinct from old.insurance_active
    or new.admin_read_only is distinct from old.admin_read_only
    or new.super_admin is distinct from old.super_admin
    or new.membership_tier is distinct from old.membership_tier
    or new.business_name is distinct from old.business_name
    or new.license_number is distinct from old.license_number
    or new.insurance_info is distinct from old.insurance_info
    or new.business_registration_number is distinct from old.business_registration_number
    or (new.active and not old.active)
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- Hauler-side entry point for the four locked fields — inserts a pending request rather than
-- touching profiles at all. Re-requesting the same field while a request is still pending updates
-- that row in place instead of piling up duplicates.
create function request_profile_change(p_field text, p_requested_value text, p_reason text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_hauler profiles%rowtype;
  v_old_value text;
  v_request_id uuid;
begin
  select * into v_hauler from profiles where id = auth.uid();
  if v_hauler.id is null or v_hauler.role <> 'hauler' then
    raise exception 'Only hauler accounts can request a profile change';
  end if;
  if p_field not in ('business_name', 'license_number', 'insurance_info', 'business_registration_number') then
    raise exception 'Invalid field';
  end if;

  v_old_value := case p_field
    when 'business_name' then v_hauler.business_name
    when 'license_number' then v_hauler.license_number
    when 'insurance_info' then v_hauler.insurance_info
    when 'business_registration_number' then v_hauler.business_registration_number
  end;

  update profile_change_requests set
    requested_value = p_requested_value, reason = p_reason, old_value = v_old_value, created_at = now()
  where hauler_id = auth.uid() and field = p_field and status = 'pending'
  returning id into v_request_id;

  if v_request_id is null then
    insert into profile_change_requests (hauler_id, field, old_value, requested_value, reason)
    values (auth.uid(), p_field, v_old_value, p_requested_value, p_reason)
    returning id into v_request_id;
  end if;

  return v_request_id;
end;
$$;
grant execute on function request_profile_change(text, text, text) to authenticated;

-- Applying a vetting-credential change (not business_name — renaming isn't a vetting concern)
-- resets verified until an admin re-confirms the hauler against the new value, mirroring how a
-- fresh document upload already clears license_active/insurance_active until reviewed.
create function approve_profile_change_request(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req profile_change_requests%rowtype;
begin
  if not is_admin() then
    raise exception 'Only admins can approve profile change requests';
  end if;

  select * into v_req from profile_change_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Change request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been resolved';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  execute format('update profiles set %I = $1 where id = $2', v_req.field)
    using v_req.requested_value, v_req.hauler_id;

  if v_req.field in ('license_number', 'insurance_info', 'business_registration_number') then
    update profiles set verified = false where id = v_req.hauler_id;
  end if;

  update profile_change_requests set
    status = 'approved', resolved_at = now(), resolved_by = auth.uid(), admin_note = p_note
  where id = p_request_id;
end;
$$;
grant execute on function approve_profile_change_request(uuid, text) to authenticated;

create function deny_profile_change_request(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only admins can deny profile change requests';
  end if;
  update profile_change_requests set
    status = 'denied', resolved_at = now(), resolved_by = auth.uid(), admin_note = p_note
  where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'This request is not pending';
  end if;
end;
$$;
grant execute on function deny_profile_change_request(uuid, text) to authenticated;

-- Delete support for verification documents (previously upload-and-replace only). A plain RLS
-- policy is enough here (unlike insert/update, delete has no cross-role column asymmetry to
-- protect) — the storage object itself is removed client-side first, same two-step pattern
-- deleteCompletionPhoto already uses elsewhere.
create policy hauler_documents_delete on hauler_documents for delete using (hauler_id = auth.uid());
grant delete on hauler_documents to authenticated;

create policy hauler_documents_storage_delete on storage.objects for delete using (
  bucket_id = 'hauler-documents' and ((storage.foldername(name))[1])::uuid = auth.uid()
);

-- Deleting an approved document removes the only evidence behind license_active/insurance_active
-- — without this, a hauler could delete their file and keep bidding on an approval nothing backs
-- anymore. Reset is per doc_type, same bypass-flag pattern submit/review already use.
create function reset_license_flag_on_doc_delete() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    license_active = case when old.doc_type = 'license' then false else license_active end,
    insurance_active = case when old.doc_type = 'insurance' then false else insurance_active end
  where id = old.hauler_id;
  return old;
end;
$$;

create trigger hauler_documents_reset_on_delete after delete on hauler_documents
  for each row execute function reset_license_flag_on_doc_delete();
