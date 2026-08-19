-- Ports audit findings M-4, M-5, and M-6 from the MyPartyBid security audit (2026-08-19) —
-- these are code-level bugs in the schema both products share, not anything specific to how
-- MyPartyBid customizes it, so they apply here unchanged apart from hauler/vendor naming and the
-- fact that this product has no category-matching concept (M-5's eligibility check is
-- radius-only here, matching this codebase's existing list_open_jobs_for_hauler()).
--
-- Confirmed present on this project's live database before writing this migration (read-only
-- checks, no data modified): guard_profile_self_update() had the identical unpatched
-- is_full_admin()-bypasses-everything logic, and all three storage buckets had
-- file_size_limit/allowed_mime_types = null. C-1 and H-1/H-2 from that audit do NOT apply here —
-- platform_fee_config already has a real seeded row on this project, and the branding/regression
-- findings were specific to the MyPartyBid fork.

-- ---------------------------------------------------------------------------------------------
-- M-4 · Storage buckets have no MIME or size restrictions
--
-- Buckets are already private with path-scoped ownership policies — this only adds the missing
-- content-type/size fence. Without it, a client that skips the resize/HEIC pipeline (client-side,
-- trivially bypassable) could upload arbitrary file types, including SVG with an embedded
-- <script> that executes if a signed URL is opened directly in a browser tab.
-- ---------------------------------------------------------------------------------------------

update storage.buckets
set file_size_limit = 10485760, -- 10 MiB
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
where id in ('job-photos', 'completion-photos');

update storage.buckets
set file_size_limit = 15728640, -- 15 MiB
    allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/png']
where id = 'hauler-documents';

-- ---------------------------------------------------------------------------------------------
-- M-5 · Open-job photos readable by *any* authenticated user
--
-- job_photos_storage_select currently grants a read whenever job_is_open_for_bid(job_id) is
-- true, with no hauler-eligibility condition at all — a logged-in customer, or a hauler outside
-- the matching radius, can read photos of any open job given its UUID (job photos routinely show
-- homes, driveways, and other property). This mirrors the radius check
-- list_open_jobs_for_hauler() already uses for browsing, so a hauler sees exactly the photos of
-- jobs they'd actually see in Find Jobs — nothing new is opened up, an existing gap is closed.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."hauler_eligible_for_job_photos"("p_job_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    select exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'hauler' and p.active
    ) and hauler_within_radius_of_job(p_job_id);
  $$;

DROP POLICY IF EXISTS "job_photos_storage_select" ON "storage"."objects";
CREATE POLICY "job_photos_storage_select" ON "storage"."objects" FOR SELECT
  USING (
    (bucket_id = 'job-photos'::text) AND (
      is_admin()
      OR customer_owns_job(((storage.foldername(name))[1])::uuid)
      OR hauler_owns_chat_job(((storage.foldername(name))[1])::uuid)
      OR (
        job_is_open_for_bid(((storage.foldername(name))[1])::uuid)
        AND hauler_eligible_for_job_photos(((storage.foldername(name))[1])::uuid)
      )
    )
  );

-- ---------------------------------------------------------------------------------------------
-- M-6 · Any full admin can silently self-promote to super admin
--
-- guard_profile_self_update()'s column blocklist for role/super_admin/admin_read_only previously
-- lived only in the branch reached by a *non*-admin editing their own row. A full admin editing
-- their own row hit `if is_full_admin() then return new; end if;` first and returned with zero
-- column restrictions — confirmed on this project's live database (read-only: pulled the
-- function body via pg_get_functiondef, did not exercise the exploit against production data).
-- Same fix as MyPartyBid: move role/super_admin/admin_read_only into the unconditional blocklist
-- at the top of the function, alongside the similarly sensitive columns (verified, license_active,
-- territory_id, ...) that already go through dedicated RPCs instead of a raw UPDATE for every
-- caller. create_admin_invite / accept_admin_invite are unaffected — both already set
-- app.bypass_profile_guard before their UPDATE, which short-circuits this function entirely.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."guard_profile_self_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true' then
    return new;
  end if;

  if new.status is distinct from old.status
    or new.suspended_at is distinct from old.suspended_at
    or new.suspended_by_admin_id is distinct from old.suspended_by_admin_id
    or new.suspension_reason is distinct from old.suspension_reason
    or new.bidding_restricted is distinct from old.bidding_restricted
    or new.posting_restricted is distinct from old.posting_restricted
    or new.deletion_requested_at is distinct from old.deletion_requested_at
    or new.deletion_reason is distinct from old.deletion_reason
    or new.deletion_scheduled_for is distinct from old.deletion_scheduled_for
    or new.anonymized_at is distinct from old.anonymized_at
    or new.deleted_at is distinct from old.deleted_at
    or new.retention_until is distinct from old.retention_until
    or new.verified is distinct from old.verified
    or new.license_active is distinct from old.license_active
    or new.insurance_active is distinct from old.insurance_active
    or new.territory_id is distinct from old.territory_id
    or new.email_verify_last_sent_at is distinct from old.email_verify_last_sent_at
    or new.role is distinct from old.role
    or new.super_admin is distinct from old.super_admin
    or new.admin_read_only is distinct from old.admin_read_only
  then
    raise exception 'Not permitted to change this field.';
  end if;

  if new.id is distinct from auth.uid() then
    if old.super_admin and (new.active is distinct from old.active) then
      raise exception 'The super admin account cannot be deactivated or modified by another admin.';
    end if;
    return new;
  end if;

  if is_full_admin() then
    return new;
  end if;

  if new.rating is distinct from old.rating
    or new.rating_count is distinct from old.rating_count
    or new.email_verified_at is distinct from old.email_verified_at
    or new.email_verify_token is distinct from old.email_verify_token
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

-- ---------------------------------------------------------------------------------------------
-- C-1 hardening (defense-in-depth only) · enforce_bid_amount_limits() fails open on NULL limits
--
-- Unlike MyPartyBid, this project's platform_fee_config already has a real seeded row (confirmed
-- read-only before writing this migration), so the bug this closes is not currently exploitable
-- here — new.amount < NULL / new.amount > NULL both evaluate to NULL, which a CHECK-style
-- comparison treats as "don't fail" rather than true. This is the same latent footgun MyPartyBid
-- hit for real (its equivalent row was never seeded, so a $0.01 bid was silently accepted) — it
-- costs nothing to also make this fail closed here rather than rely on the row never going
-- missing. Domain in the error message is left as this project's own (support@mytrashbid.com,
-- already correct) — MyPartyBid's version of this fix also routed that string through
-- app_config, but that was fixing a *different*, MyPartyBid-specific bug (a leftover reference to
-- this project's domain), which doesn't apply here.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."enforce_bid_amount_limits"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_min numeric; v_max numeric;
begin
  select min_bid_amount, max_job_amount into v_min, v_max from platform_fee_config where id = true;

  if v_min is null or v_max is null then
    raise exception 'Bid limits are not configured — contact support before bidding.';
  end if;

  if new.amount < v_min then
    raise exception 'BID_TOO_LOW: Bids must be at least $% — enter a higher amount.', v_min;
  end if;
  if new.amount > v_max then
    raise exception 'MAX_JOB_AMOUNT: For jobs over $%, please contact us at support@mytrashbid.com so we can help you directly.', v_max;
  end if;
  return new;
end;
$$;
