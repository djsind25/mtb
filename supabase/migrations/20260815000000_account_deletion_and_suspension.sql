-- MyTrashBid — Account Deletion & Suspension (launch-essential)
--
-- Adds a soft-delete/anonymization lifecycle for accounts WITH real history, alongside the
-- existing hard-delete (admin_delete_user, 20260811000000_admin_delete_user.sql — still scoped to
-- zero-activity accounts only, left untouched) and the existing abuse-deactivation flag (`active`,
-- 20260707015450_user_deactivation.sql — also left untouched, still an independent concept).
--
-- Trimmed to launch-essential scope: single admin role (is_full_admin(), no new tiers), no
-- background worker (anonymization runs on-access + a manual admin trigger), no Stripe
-- payout-account automation (stubbed client-side only — this app has none today), no automated
-- file-retention cleanup (DB pointer columns only, storage objects are a manual admin step).

-- ─── 1. profiles: new lifecycle columns ────────────────────────────────────────────────────────

alter table profiles
  add column status text not null default 'active'
    check (status in ('active', 'suspended', 'deletion_requested', 'anonymized', 'deleted')),
  add column suspended_at            timestamptz,
  add column suspended_by_admin_id   uuid references profiles(id),
  add column suspension_reason       text,
  -- Narrower than a full status transition — independent booleans, same "flat column today, clean
  -- seam to diverge later" idiom membership_tier already established in this codebase.
  add column bidding_restricted      boolean not null default false,
  add column posting_restricted      boolean not null default false,
  add column deletion_requested_at   timestamptz,
  add column deletion_reason         text,
  add column deletion_scheduled_for  timestamptz,
  add column anonymized_at           timestamptz,
  add column deleted_at              timestamptz,
  add column retention_until         timestamptz;

create index profiles_status_idx on profiles (status);
-- Due-deletion lookup used by process_due_account_deletions() below.
create index profiles_deletion_scheduled_for_idx on profiles (deletion_scheduled_for)
  where status = 'deletion_requested';

insert into app_config (key, value) values ('file_retention_days', '90') on conflict (key) do nothing;

-- ─── 2. is_active_user() — widened, not synced/duplicated ──────────────────────────────────────
--
-- `active` keeps its existing, independent meaning (abuse deactivation). Rather than syncing it
-- from `status` (which would collide the moment a suspended account is also separately
-- deactivated, or silently re-activate a deactivated account on an unrelated status write) or
-- threading a second helper through ~20 existing call sites, this widens the ONE function nearly
-- every existing write path already calls — every one of them (bids_insert, jobs_insert_own,
-- messages_insert, reviews_insert, job_qna policies, hauler_mark_done,
-- customer_acknowledge_completion, request_cancellation, propose_schedule/confirm_schedule,
-- request_chat_support, etc.) automatically also blocks suspended/deletion_requested/anonymized/
-- deleted accounts with zero edits to any of them.
create or replace function is_active_user() returns boolean
  language sql stable security definer set search_path = public as $$
    select coalesce((select active and status = 'active' from profiles where id = auth.uid()), false);
  $$;

-- The one call site that reads profiles.active inline instead of calling the helper above.
-- Byte-for-byte identical to the current 20260804000000_hauler_dashboard_enhancements.sql
-- definition otherwise — only the activity check widens, no signature/column change.
create or replace function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date, timeline text,
  created_at timestamptz, first_posted_at timestamptz, expires_at timestamptz, bid_count bigint,
  distance_mi numeric, photo_count bigint, city text, state text, is_dismissed boolean
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
  if not (v_hauler.active and v_hauler.status = 'active') then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  v_radius := membership_max_radius_mi(v_hauler.membership_tier);

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode,
      j.service_type, j.dumpster_type, j.rental_start_date, j.rental_end_date, j.timeline,
      j.created_at, j.first_posted_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count,
      z.city, z.state,
      exists(select 1 from hauler_dismissed_jobs d where d.job_id = j.id and d.hauler_id = auth.uid()) as is_dismissed
    from jobs j
    left join zip_geo z on z.zip = j.zip
    where j.status = 'open' and j.expires_at > now()
      -- Already-bid jobs belong in My Bids, not Find Jobs.
      and not exists (select 1 from bids b2 where b2.job_id = j.id and b2.hauler_id = auth.uid())
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;
grant execute on function list_open_jobs_for_hauler() to authenticated;

-- ─── 3. guard_profile_self_update() — lifecycle columns become RPC-only, even for full admins ──
--
-- profiles_update_own RLS already restricts "editing another user's row" to is_full_admin() (see
-- 20260717010000_view_only_admin.sql), so the existing "new.id is distinct from auth.uid()" branch
-- below is only ever reached by a full admin already — and today it just `return new`s (allowing
-- ANY column change except the super-admin-protected ones) via the plain EditUserModal/
-- updateUserProfile() table write. Without a carve-out, a full admin could set
-- status='anonymized' through that same raw update with zero reauth, zero mandatory reason, zero
-- audit row, and zero blocker check — defeating this feature's entire security model. So the new
-- lifecycle columns are locked to RPC-only (via app.bypass_profile_guard) *before* either existing
-- branch runs, for both self-updates and admin-on-other-user updates alike.
create or replace function guard_profile_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
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
  then
    raise exception 'Not permitted to change this field.';
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

-- ─── 4. RLS: bidding/posting restriction gates + hide non-active haulers' pending bids ──────────

drop policy jobs_insert_own on jobs;
create policy jobs_insert_own on jobs for insert with check (
  customer_id = auth.uid() and is_active_user()
  and not (select posting_restricted from profiles where id = auth.uid())
);

drop policy bids_insert on bids;
create policy bids_insert on bids for insert with check (
  hauler_id = auth.uid()
  and is_active_user()
  and not (select bidding_restricted from profiles where id = auth.uid())
  and exists (
    select 1 from profiles
    where profiles.id = auth.uid() and profiles.role = 'hauler'
      and profiles.license_active and profiles.insurance_active
  )
  and user_has_verified_mfa(auth.uid())
  and job_is_open_for_bid(bids.job_id)
  and (
    (select membership_max_bids_per_month(membership_tier) from profiles where id = auth.uid()) is null
    or (select count(*) from bids b2 where b2.hauler_id = auth.uid()
         and date_trunc('month', b2.created_at) = date_trunc('month', now()))
       < (select membership_max_bids_per_month(membership_tier) from profiles where id = auth.uid())
  )
);

-- Whether a bid is the job's accepted bid — SECURITY DEFINER so this runs as the table owner
-- (bypassing RLS) when called from inside another table's RLS policy, exactly like
-- customer_owns_job()/hauler_bid_on_job()/job_is_open_for_bid() already do. A plain inline
-- subquery on `jobs` here instead would apply jobs_select's own RLS (which itself checks
-- hauler_bid_on_job() against `bids`), and that cross-table policy-evaluating-policy shape is what
-- triggers Postgres's "infinite recursion detected in policy for relation bids" — this helper
-- avoids that entirely, the same reason every other cross-table RLS check in this schema already
-- goes through a security-definer function rather than an inline subquery.
create function bid_is_accepted(p_bid_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from jobs where jobs.accepted_bid_id = p_bid_id);
  $$;

-- Same reasoning as bid_is_accepted() above, for the same reason — a plain inline
-- `exists (select 1 from profiles where profiles.id = bids.hauler_id and ...)` clause directly in
-- bids_select was empirically confirmed (via manual testing against this exact schema) to trigger
-- "infinite recursion detected in policy for relation bids" the moment bids_insert's own
-- monthly-bid-cap subquery (`from bids b2 ...`, pre-existing, unchanged) re-evaluates bids_select
-- for those b2 rows — wrapping the profiles lookup in its own security-definer function avoids it,
-- matching every other cross-table RLS check in this schema.
create function hauler_status_active(p_hauler_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where profiles.id = p_hauler_id and profiles.status = 'active');
  $$;

-- Hides a non-active-status hauler's still-pending bid from the customer (the "vanish from
-- search" requirement — this app has no hauler directory; customers only ever see a hauler via
-- bids on their own job, queried directly against this table). The accepted bid always stays
-- visible regardless of the hauler's later status, so an already-booked job's history survives
-- suspension/deletion untouched.
drop policy bids_select on bids;
create policy bids_select on bids for select using (
  hauler_id = auth.uid()
  or is_admin()
  or (
    customer_owns_job(bids.job_id)
    and (bid_is_accepted(bids.id) or hauler_status_active(bids.hauler_id))
  )
);

-- ─── 5. account_lifecycle_audit_log — append-only, same idiom as chat_admin_audit_log/admin_user_flags ──

create table account_lifecycle_audit_log (
  id               uuid primary key default gen_random_uuid(),
  actor_id         uuid references profiles(id),        -- null = self-service or the system sweep
  target_user_id   uuid not null references profiles(id),
  action           text not null check (action in (
    'deletion_requested', 'deletion_cancelled_self', 'deletion_cancelled_admin',
    'deletion_started_admin', 'deletion_paused_blocker_found',
    'suspended', 'restored', 'bidding_restricted_set', 'posting_restricted_set',
    'anonymized', 'marked_deleted', 'files_purged'
  )),
  previous_status  text,
  new_status       text,
  reason           text,
  ip_address       text,
  user_agent       text,
  blockers_present jsonb,
  override_used    boolean not null default false,
  retention_date   timestamptz,
  created_at       timestamptz not null default now()
);
create index account_lifecycle_audit_log_target_idx on account_lifecycle_audit_log (target_user_id);
create index account_lifecycle_audit_log_created_idx on account_lifecycle_audit_log (created_at desc);

alter table account_lifecycle_audit_log enable row level security;
grant select on account_lifecycle_audit_log to authenticated;
create policy account_lifecycle_audit_log_select on account_lifecycle_audit_log for select using (is_admin());
-- No insert/update/delete policy at all — append-only, written exclusively by
-- log_account_lifecycle_event() below (security definer, never granted to authenticated).

-- IP address is honestly left unpopulated by these RPCs (a browser can't reliably learn its own
-- public IP and there's no edge-function hop in front of these calls today) — same "manual/stub
-- for now" posture as the Stripe stub. User-agent is captured from an optional
-- p_client_user_agent param on every mutating RPC below, client-populated from navigator.userAgent.
create function log_account_lifecycle_event(
  p_target_user_id uuid, p_actor_id uuid, p_action text,
  p_previous_status text, p_new_status text, p_reason text,
  p_blockers jsonb, p_override_used boolean, p_retention_date timestamptz,
  p_ip_address text, p_user_agent text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into account_lifecycle_audit_log (
    target_user_id, actor_id, action, previous_status, new_status, reason,
    ip_address, user_agent, blockers_present, override_used, retention_date
  ) values (
    p_target_user_id, p_actor_id, p_action, p_previous_status, p_new_status, p_reason,
    p_ip_address, p_user_agent, p_blockers, coalesce(p_override_used, false), p_retention_date
  );
end;
$$;
-- Internal only — never granted to authenticated. Called from inside the other security definer
-- functions below (which already own the request's privilege context), same as
-- notify_both_parties-style internal helpers elsewhere in this codebase.
revoke execute on function log_account_lifecycle_event(uuid, uuid, text, text, text, text, jsonb, boolean, timestamptz, text, text) from public;

-- ─── 6. Centralized blocker check — ONE function, used by both self-service and admin flows ────

create function check_account_deletion_blockers(p_target_user_id uuid default null)
returns table (blocker_type text, message text, link_kind text, link_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid;
begin
  -- IDOR prevention: a non-admin can only ever check their own account.
  if p_target_user_id is not null and p_target_user_id <> auth.uid() and not is_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Not authorized to check this account.';
  end if;
  v_uid := coalesce(p_target_user_id, auth.uid());
  if v_uid is null then
    raise exception 'No account specified.';
  end if;

  return query
  -- active_job (customer side): an open job, or a booked job not yet completed. jobs.status
  -- never becomes 'completed' — completion is the separate completed/completed_at boolean+
  -- timestamp layered on top of status='booked', so this checks the boolean, not status.
  select 'active_job'::text,
    format('Your job "%s" is still open or in progress.', j.title), 'job'::text, j.id
  from jobs j
  where j.customer_id = v_uid and (j.status = 'open' or (j.status = 'booked' and not j.completed))

  union all
  -- accepted_bid_incomplete (hauler side): derived from jobs.accepted_bid_id -> bids.hauler_id,
  -- since bids has no status column of its own.
  select 'accepted_bid_incomplete'::text,
    format('You''re the assigned hauler on "%s", which hasn''t been marked complete yet.', j.title),
    'job'::text, j.id
  from jobs j join bids b on b.id = j.accepted_bid_id
  where b.hauler_id = v_uid and j.status = 'booked' and not j.completed

  union all
  -- pending_payment / pending_payout: unsettled deposit-mode commission, or an authorized-but-not-
  -- yet-captured full-mode hold, on any of this user's non-superseded chats. This app has no
  -- Stripe Connect/payout-account mechanism (haulers are paid off-platform for deposit-mode,
  -- platform holds/releases plain PaymentIntents for full-mode), so "pending payout" and "pending
  -- payment" are the same real-world state today — reserved seam for when a real payout mechanism
  -- exists and needs its own distinct check.
  select 'pending_payment'::text,
    format('Job "%s" has a balance that hasn''t finished settling yet.', j.title), 'chat'::text, c.id
  from chats c join jobs j on j.id = c.job_id
  where c.superseded_at is null and (c.customer_id = v_uid or c.hauler_id = v_uid)
    and (c.commission_status = 'held'
      or (c.payment_mode = 'full' and c.authorized_at is not null and c.captured_at is null))

  union all
  -- pending_payment: a resolved cancellation whose refund payment row hasn't reached 'succeeded'.
  -- Defensive — resolve_cancellation() only ever inserts already-succeeded refund rows today, so
  -- this is currently unreachable, but cheap and forward-safe against a future partial-refund flow.
  select 'pending_payment'::text,
    format('A refund for "%s" is still processing.', j.title), 'job'::text, j.id
  from cancellation_requests cr join jobs j on j.id = cr.job_id
  where cr.status = 'resolved'
    and (j.customer_id = v_uid or exists (select 1 from chats c2 where c2.id = cr.chat_id and c2.hauler_id = v_uid))
    and exists (select 1 from payments p where p.job_id = cr.job_id and p.kind = 'refund' and p.status <> 'succeeded')

  union all
  -- open_dispute (a): a pending cancellation request (also covers the "pending refund"
  -- requirement — deliberately not double-counted as a separate blocker type).
  select 'open_dispute'::text,
    format('A cancellation request on "%s" is still under review.', j.title), 'job'::text, j.id
  from cancellation_requests cr join jobs j on j.id = cr.job_id
  where cr.status = 'pending'
    and (j.customer_id = v_uid or exists (select 1 from chats c3 where c3.id = cr.chat_id and c3.hauler_id = v_uid))

  union all
  -- open_dispute (b): open job-chat support (requested/active support_status, or a pending
  -- support_requests row).
  select 'open_dispute'::text, 'A support conversation on one of your jobs is still open.'::text,
    'chat'::text, c4.id
  from chats c4
  where c4.superseded_at is null and (c4.customer_id = v_uid or c4.hauler_id = v_uid)
    and (c4.support_status in ('requested', 'active')
      or exists (select 1 from support_requests sr where sr.chat_id = c4.id and sr.status = 'pending'))

  union all
  -- open_dispute (c): an unresolved manual admin flag on this user.
  select 'open_dispute'::text, 'Your account has an open review flag that needs to be resolved first.'::text,
    'flag'::text, f.id
  from admin_user_flags f
  where f.user_id = v_uid and f.resolved_at is null;
end;
$$;
revoke execute on function check_account_deletion_blockers(uuid) from public;
grant execute on function check_account_deletion_blockers(uuid) to authenticated;

-- ─── 7. Deletion email dispatcher — mirrors dispatch_verification_email's shape verbatim ────────

create function dispatch_account_deletion_email(p_profile_id uuid, p_kind text) returns void
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
    url := v_base_url || '/send-account-deletion-email',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object('profileId', p_profile_id, 'kind', p_kind)
  );
exception when others then
  raise warning 'dispatch_account_deletion_email failed for % (%): %', p_profile_id, p_kind, sqlerrm;
end;
$$;
revoke execute on function dispatch_account_deletion_email(uuid, text) from public;

-- ─── 8. Self-service deletion RPCs ──────────────────────────────────────────────────────────────

-- Reauth mirrors deactivate_own_account exactly: verified TOTP -> require_aal2(); else a password
-- on file -> re-check it directly; pure-OAuth-no-password -> nothing left to check.
create function request_own_account_deletion(
  p_reason text default null, p_password text default null, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_profile profiles%rowtype;
  v_encrypted text;
  v_blocker_count int;
begin
  select * into v_profile from profiles where id = auth.uid() for update;
  if v_profile.id is null then raise exception 'Profile not found.'; end if;
  if v_profile.role = 'admin' then raise exception 'Admin accounts use the admin-side actions, not self-service deletion.'; end if;
  if v_profile.status = 'deletion_requested' then
    raise exception 'DELETION_ALREADY_REQUESTED: A deletion request is already pending for this account.';
  end if;
  if v_profile.status in ('anonymized', 'deleted') then
    raise exception 'ACCOUNT_ALREADY_ANONYMIZED: This account has already been closed.';
  end if;
  if v_profile.status = 'suspended' then
    raise exception 'Your account is suspended — contact support before requesting deletion.';
  end if;

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

  select count(*) into v_blocker_count from check_account_deletion_blockers(auth.uid());
  if v_blocker_count > 0 then
    raise exception 'ACCOUNT_DELETION_BLOCKED: Your account can''t be deleted yet — resolve the items listed and try again.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    status = 'deletion_requested', deletion_requested_at = now(),
    deletion_reason = p_reason, deletion_scheduled_for = now() + interval '30 days'
  where id = auth.uid();

  perform log_account_lifecycle_event(auth.uid(), null, 'deletion_requested', v_profile.status, 'deletion_requested',
    p_reason, null, false, now() + interval '30 days', null, p_client_user_agent);
  perform dispatch_account_deletion_email(auth.uid(), 'requested');
end;
$$;
revoke execute on function request_own_account_deletion(text, text, text) from public;
grant execute on function request_own_account_deletion(text, text, text) to authenticated;

-- Cancel, gated by the exact same reauth chain (reauth required to cancel too, per the confirmed
-- decision — a stolen session that reaches the account can't just click a state back to active).
create function cancel_own_pending_deletion(
  p_password text default null, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype; v_encrypted text;
begin
  select * into v_profile from profiles where id = auth.uid() for update;
  if v_profile.status <> 'deletion_requested' then
    raise exception 'There is no pending deletion request on this account.';
  end if;

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

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'active', deletion_requested_at = null, deletion_reason = null, deletion_scheduled_for = null
  where id = auth.uid();

  perform log_account_lifecycle_event(auth.uid(), null, 'deletion_cancelled_self', 'deletion_requested', 'active',
    null, null, false, null, null, p_client_user_agent);
  perform dispatch_account_deletion_email(auth.uid(), 'cancelled');
end;
$$;
revoke execute on function cancel_own_pending_deletion(text, text) from public;
grant execute on function cancel_own_pending_deletion(text, text) to authenticated;

-- ─── 9. Admin suspend/restore/restrict RPCs ─────────────────────────────────────────────────────

create function admin_suspend_user(p_user_id uuid, p_reason text, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can suspend an account.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role = 'admin' then raise exception 'Admin accounts cannot be suspended here.'; end if;
  if v_profile.status = 'suspended' then raise exception 'This account is already suspended.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'suspended', suspended_at = now(), suspended_by_admin_id = auth.uid(), suspension_reason = p_reason
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'suspended', v_profile.status, 'suspended',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_suspend_user(uuid, text, text) from public;
grant execute on function admin_suspend_user(uuid, text, text) to authenticated;

create function admin_restore_user(p_user_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can restore an account.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.status <> 'suspended' then raise exception 'This account is not currently suspended.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'active', suspended_at = null, suspended_by_admin_id = null, suspension_reason = null
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'restored', 'suspended', 'active',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_restore_user(uuid, text, text) from public;
grant execute on function admin_restore_user(uuid, text, text) to authenticated;

create function admin_set_bidding_restricted(
  p_user_id uuid, p_restricted boolean, p_reason text default null, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can change this.'; end if;
  perform require_aal2();
  if p_restricted and (p_reason is null or trim(p_reason) = '') then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role <> 'hauler' then raise exception 'Only hauler accounts can be bidding-restricted.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set bidding_restricted = p_restricted where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'bidding_restricted_set', null, null,
    p_reason, jsonb_build_object('restricted', p_restricted), false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_set_bidding_restricted(uuid, boolean, text, text) from public;
grant execute on function admin_set_bidding_restricted(uuid, boolean, text, text) to authenticated;

create function admin_set_posting_restricted(
  p_user_id uuid, p_restricted boolean, p_reason text default null, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can change this.'; end if;
  perform require_aal2();
  if p_restricted and (p_reason is null or trim(p_reason) = '') then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role <> 'customer' then raise exception 'Only customer accounts can be posting-restricted.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set posting_restricted = p_restricted where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'posting_restricted_set', null, null,
    p_reason, jsonb_build_object('restricted', p_restricted), false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_set_posting_restricted(uuid, boolean, text, text) from public;
grant execute on function admin_set_posting_restricted(uuid, boolean, text, text) to authenticated;

-- ─── 10. Admin start/cancel deletion RPCs ───────────────────────────────────────────────────────

create function admin_start_deletion(
  p_user_id uuid, p_reason text, p_override boolean default false, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype; v_blockers jsonb;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can start a deletion.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role = 'admin' then raise exception 'Admin accounts are not managed through this flow.'; end if;
  if v_profile.status = 'deletion_requested' then raise exception 'DELETION_ALREADY_REQUESTED: Already pending.'; end if;
  if v_profile.status in ('anonymized', 'deleted') then raise exception 'ACCOUNT_ALREADY_ANONYMIZED: Already closed.'; end if;

  select jsonb_agg(to_jsonb(b)) into v_blockers from check_account_deletion_blockers(p_user_id) b;
  if v_blockers is not null and jsonb_array_length(v_blockers) > 0 and not p_override then
    raise exception 'ACCOUNT_DELETION_BLOCKED: This account has open items — resolve them, or override with a reason.';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'deletion_requested', deletion_requested_at = now(), deletion_reason = p_reason,
    deletion_scheduled_for = now() + interval '30 days'
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'deletion_started_admin', v_profile.status, 'deletion_requested',
    p_reason, v_blockers, coalesce(p_override, false) and v_blockers is not null, now() + interval '30 days', null, p_client_user_agent);
  perform dispatch_account_deletion_email(p_user_id, 'requested');
end;
$$;
revoke execute on function admin_start_deletion(uuid, text, boolean, text) from public;
grant execute on function admin_start_deletion(uuid, text, boolean, text) to authenticated;

create function admin_cancel_pending_deletion(
  p_user_id uuid, p_reason text default null, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can cancel a pending deletion.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.status <> 'deletion_requested' then raise exception 'There is no pending deletion request on this account.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'active', deletion_requested_at = null, deletion_reason = null, deletion_scheduled_for = null
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'deletion_cancelled_admin', 'deletion_requested', 'active',
    p_reason, null, false, null, null, p_client_user_agent);
  perform dispatch_account_deletion_email(p_user_id, 'cancelled');
end;
$$;
revoke execute on function admin_cancel_pending_deletion(uuid, text, text) from public;
grant execute on function admin_cancel_pending_deletion(uuid, text, text) to authenticated;

-- ─── 11. Anonymization — ONE centralized, idempotent function ──────────────────────────────────

create function anonymize_account(p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_profile profiles%rowtype;
  v_placeholder_name text;
begin
  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'Profile not found.'; end if;
  -- Idempotency guarantee: already-anonymized/deleted accounts are a silent no-op, not an error —
  -- safe to call repeatedly from the opportunistic sweep, a retried admin action, etc.
  if v_profile.status in ('anonymized', 'deleted') then return; end if;

  v_placeholder_name := case when v_profile.role = 'hauler' then 'Former Service Provider' else 'Deleted Customer' end;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    name = v_placeholder_name,
    business_name = case when v_profile.role = 'hauler' then v_placeholder_name else business_name end,
    email = 'deleted-user-' || p_user_id::text || '@deleted.mytrashbid.invalid',  -- profiles.id is
      -- already a unique PK, so this is trivially collision-safe without a uniqueness check.
    phone = null, zip = '', lat = null, lng = null, avatar = null, bio = null,
    business_registration_number = null, license_number = null, insurance_info = null,
    notification_prefs = jsonb_build_object('email', false, 'sms', false, 'events', '{}'::jsonb, 'smsEvents', '{}'::jsonb),
    sms_consent = false,
    anonymized_at = now(),
    retention_until = now() + make_interval(days => app_config_numeric('file_retention_days')::int),
    status = 'anonymized'
  where id = p_user_id;

  -- Deliberately untouched: jobs, bids, chats, messages, payments, reviews, cancellation_requests,
  -- admin_user_flags — profiles.id (the FK target everywhere) never changes, so every historical
  -- record and amount stays intact and simply resolves the new placeholder name at display time.
  -- reviews has no user_id at all (chat_id, reviewer_role only) — genuinely zero changes needed.
  perform log_account_lifecycle_event(p_user_id, null, 'anonymized', v_profile.status, 'anonymized', null, null, false, null, null, null);
end;
$$;
-- Internal only — no grant to authenticated. Called from admin_anonymize_now() and
-- process_due_account_deletions() below (definer-privilege call from inside another
-- security definer function).
revoke execute on function anonymize_account(uuid) from public;

create function admin_anonymize_now(
  p_user_id uuid, p_reason text, p_force boolean default false, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype; v_blockers jsonb; v_previous_status text;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can anonymize an account.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.status <> 'deletion_requested' then
    raise exception 'This account has no pending deletion to process.';
  end if;
  if not p_force and v_profile.deletion_scheduled_for > now() then
    raise exception 'This account is not due for anonymization yet — use force if you''re sure.';
  end if;

  select jsonb_agg(to_jsonb(b)) into v_blockers from check_account_deletion_blockers(p_user_id) b;
  if v_blockers is not null and jsonb_array_length(v_blockers) > 0 and not p_force then
    raise exception 'ACCOUNT_DELETION_BLOCKED: New blockers appeared — override with force if you''re sure.';
  end if;

  v_previous_status := v_profile.status;
  perform anonymize_account(p_user_id);
  -- Re-stamp actor/reason/override on top of anonymize_account()'s own system-actor log row —
  -- adds a second, admin-attributed audit row rather than mutating the first (append-only).
  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'anonymized', v_previous_status, 'anonymized', p_reason, v_blockers,
    p_force and v_blockers is not null, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_anonymize_now(uuid, text, boolean, text) from public;
grant execute on function admin_anonymize_now(uuid, text, boolean, text) to authenticated;

create function admin_mark_deleted(p_user_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can do this.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.status <> 'anonymized' then raise exception 'Only an anonymized account can be marked deleted.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'deleted', deleted_at = now() where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'marked_deleted', 'anonymized', 'deleted',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_mark_deleted(uuid, text, text) from public;
grant execute on function admin_mark_deleted(uuid, text, text) to authenticated;

-- Manual for now, per this task's explicit instruction: this only clears DB pointer columns.
-- TODO — actually deleting the underlying Storage objects (hauler-documents/<uid>/..., the job
-- photos bucket) is a manual admin step for now; a future background worker should remove the
-- Storage objects BEFORE nulling these columns, not instead of.
create function admin_purge_retained_files(p_user_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can do this.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.status <> 'anonymized' then raise exception 'Only an anonymized account has files to purge.'; end if;
  if v_profile.retention_until is null or v_profile.retention_until > now() then
    raise exception 'This account is still within its file-retention window.';
  end if;

  update hauler_documents set storage_path = null, original_name = null where hauler_id = p_user_id;
  update job_completion_photos set storage_path = null, original_name = null where uploaded_by = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'files_purged', 'anonymized', 'anonymized',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;
revoke execute on function admin_purge_retained_files(uuid, text, text) from public;
grant execute on function admin_purge_retained_files(uuid, text, text) to authenticated;

-- ─── 12. Due-for-anonymization on-access sweep + manual admin trigger — ONE function, two paths ─

create function process_due_account_deletions() returns void
language plpgsql security definer set search_path = public as $$
declare r record; v_blockers jsonb;
begin
  -- Global sweep, exactly like sync_full_payment_schedule() — not scoped to the calling user.
  for r in
    select id from profiles
    where status = 'deletion_requested' and deletion_scheduled_for <= now()
    for update skip locked
  loop
    select jsonb_agg(to_jsonb(b)) into v_blockers from check_account_deletion_blockers(r.id) b;
    if v_blockers is not null and jsonb_array_length(v_blockers) > 0 then
      -- Re-check blockers when processing a due deletion; if a new one appeared, pause and record
      -- it rather than proceeding — status stays 'deletion_requested', so the admin queue
      -- naturally surfaces it as "past due, blocked" on the next load.
      perform log_account_lifecycle_event(r.id, null, 'deletion_paused_blocker_found', 'deletion_requested', 'deletion_requested',
        null, v_blockers, false, null, null, null);
    else
      perform anonymize_account(r.id);
    end if;
  end loop;
end;
$$;
revoke execute on function process_due_account_deletions() from public;
grant execute on function process_due_account_deletions() to authenticated;
