-- MyTrashBid — Territory admins
--
-- A territory_admin is NOT a new `role` value (profiles.role's check constraint stays
-- ('customer','hauler','admin'), and is_admin()/is_full_admin() stay untouched) — it's an admin
-- (role='admin') with a non-null territory_id, the same "flat column layered on role='admin'"
-- idiom as admin_read_only/super_admin. territory_id = null means unrestricted (today's
-- behavior, unchanged) for every existing full/view-only admin and the super admin.
--
-- Territories support three scope granularities so coverage can start broad and get narrowed as
-- the platform grows regionally: 'all' (nationwide), 'states' (one or more states), or 'zips' (a
-- specific ZIP list). scope_type is immutable after creation — narrowing means creating new,
-- finer territories and reassigning ZIPs/admins into them, not mutating an existing one in place.

-- ─── 1. Tables ──────────────────────────────────────────────────────────────────────────────────

create table territories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  scope_type  text not null check (scope_type in ('all', 'states', 'zips')),
  created_at  timestamptz not null default now()
);

create table territory_states (
  territory_id  uuid not null references territories(id) on delete cascade,
  state         text not null,  -- 2-letter USPS code
  primary key (territory_id, state)
);

alter table territories enable row level security;
alter table territory_states enable row level security;
grant select on territories, territory_states to authenticated;
-- Read-only for any admin (territory_admins need to see their own territory's definition);
-- every write goes through the security-definer RPCs in the companion migration.
create policy territories_select on territories for select using (is_admin());
create policy territory_states_select on territory_states for select using (is_admin());

alter table zip_geo add column territory_id uuid references territories(id);  -- only meaningful when the owning territory's scope_type = 'zips'
alter table profiles add column territory_id uuid references territories(id); -- which territory this admin is assigned to (null = unrestricted)

-- ─── 2. Backfill zip_geo.state ─────────────────────────────────────────────────────────────────
--
-- Required for "states"-scope territories to work nationwide, not just the 29 originally-seeded
-- Homer Glen, IL rows — the ~33.8k-row nationwide import (20260717180000_nationwide_zip_geo.sql)
-- deliberately left `state` null. ZIP-to-state is derived from the standard USPS ZIP3-prefix
-- range table (stable public reference data). This is a best-effort derivation — a handful of
-- 3-digit prefixes straddle two states — correctable later with a manual `update`.
update zip_geo set state = (case
  when z3 = 5 then 'NY'
  when z3 between 6 and 9 then 'PR'
  when z3 between 10 and 27 then 'MA'
  when z3 between 28 and 29 then 'RI'
  when z3 between 30 and 38 then 'NH'
  when z3 between 39 and 49 then 'ME'
  when z3 between 50 and 59 then 'VT'
  when z3 between 60 and 69 then 'CT'
  when z3 between 70 and 89 then 'NJ'
  when z3 between 100 and 149 then 'NY'
  when z3 between 150 and 196 then 'PA'
  when z3 between 197 and 199 then 'DE'
  when z3 between 200 and 205 then 'DC'
  when z3 between 206 and 219 then 'MD'
  when z3 between 220 and 246 then 'VA'
  when z3 between 247 and 268 then 'WV'
  when z3 between 270 and 289 then 'NC'
  when z3 between 290 and 299 then 'SC'
  when z3 between 300 and 319 then 'GA'
  when z3 between 320 and 339 then 'FL'
  when z3 between 340 and 349 then 'FL'
  when z3 between 350 and 352 then 'AL'
  when z3 between 354 and 369 then 'AL'
  when z3 between 370 and 385 then 'TN'
  when z3 between 386 and 397 then 'MS'
  when z3 between 398 and 399 then 'GA'
  when z3 between 400 and 427 then 'KY'
  when z3 between 430 and 459 then 'OH'
  when z3 between 460 and 479 then 'IN'
  when z3 between 480 and 499 then 'MI'
  when z3 between 500 and 528 then 'IA'
  when z3 between 530 and 549 then 'WI'
  when z3 between 550 and 567 then 'MN'
  when z3 between 570 and 577 then 'SD'
  when z3 between 580 and 588 then 'ND'
  when z3 between 590 and 599 then 'MT'
  when z3 between 600 and 629 then 'IL'
  when z3 between 630 and 658 then 'MO'
  when z3 between 660 and 679 then 'KS'
  when z3 between 680 and 693 then 'NE'
  when z3 between 700 and 714 then 'LA'
  when z3 between 716 and 729 then 'AR'
  when z3 between 730 and 749 then 'OK'
  when z3 between 750 and 799 then 'TX'
  when z3 between 800 and 816 then 'CO'
  when z3 between 820 and 831 then 'WY'
  when z3 between 832 and 838 then 'ID'
  when z3 between 840 and 847 then 'UT'
  when z3 between 850 and 865 then 'AZ'
  when z3 between 870 and 884 then 'NM'
  when z3 between 889 and 898 then 'NV'
  when z3 between 900 and 961 then 'CA'
  when z3 between 967 and 968 then 'HI'
  when z3 between 970 and 979 then 'OR'
  when z3 between 980 and 994 then 'WA'
  when z3 between 995 and 999 then 'AK'
  else null
end)
from (select zip, left(zip, 3)::int as z3 from zip_geo where state is null and zip ~ '^[0-9]{5}$') src
where zip_geo.zip = src.zip;

-- ─── 3. Helper functions ────────────────────────────────────────────────────────────────────────

create function admin_territory_id() returns uuid
  language sql stable security definer set search_path = public as $$
    select territory_id from profiles where id = auth.uid() and role = 'admin';
  $$;

-- true if p_territory_id is null (unrestricted) or p_zip falls inside that territory's scope
create function zip_in_territory(p_zip text, p_territory_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select p_territory_id is null or exists (
      select 1 from territories t
      where t.id = p_territory_id and (
        t.scope_type = 'all'
        or (t.scope_type = 'states' and exists (
              select 1 from zip_geo z join territory_states ts on ts.state = z.state
              where z.zip = p_zip and ts.territory_id = t.id))
        or (t.scope_type = 'zips' and exists (
              select 1 from zip_geo z where z.zip = p_zip and z.territory_id = t.id))
      )
    );
  $$;

create function user_in_admin_territory(p_user_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles p where p.id = p_user_id and zip_in_territory(p.zip, admin_territory_id()));
  $$;

create function job_in_admin_territory(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from jobs j where j.id = p_job_id and zip_in_territory(j.zip, admin_territory_id()));
  $$;

-- ─── 4. RLS scoping — profiles, jobs, and every job/user-linked table ─────────────────────────────

alter policy profiles_select_own on profiles using (id = auth.uid() or (is_admin() and user_in_admin_territory(profiles.id)));
alter policy profiles_update_own on profiles
  using (id = auth.uid() or (is_full_admin() and user_in_admin_territory(profiles.id)))
  with check (id = auth.uid() or (is_full_admin() and user_in_admin_territory(profiles.id)));

alter policy jobs_select on jobs using (
  customer_id = auth.uid()
  or (is_admin() and job_in_admin_territory(jobs.id))
  or hauler_bid_on_job(jobs.id)
);
alter policy jobs_update_own on jobs using (customer_id = auth.uid() or (is_full_admin() and job_in_admin_territory(jobs.id)));

alter policy job_photos_select on job_photos using (
  customer_owns_job(job_photos.job_id) or job_is_open_for_bid(job_photos.job_id)
  or (is_admin() and job_in_admin_territory(job_photos.job_id))
);

alter policy bids_select on bids using (
  hauler_id = auth.uid()
  or (is_admin() and job_in_admin_territory(bids.job_id))
  or (
    customer_owns_job(bids.job_id)
    and (bid_is_accepted(bids.id) or hauler_status_active(bids.hauler_id))
  )
);

alter policy chats_select on chats using (
  customer_id = auth.uid() or hauler_id = auth.uid() or (is_admin() and job_in_admin_territory(chats.job_id))
);

alter policy messages_select on messages using (
  (visibility = 'participants'
    and exists (select 1 from chats where chats.id = messages.chat_id
      and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid())))
  or (is_admin() and exists (select 1 from chats c where c.id = messages.chat_id and job_in_admin_territory(c.job_id)))
);
alter policy messages_update_admin on messages
  using (is_full_admin() and exists (select 1 from chats c where c.id = messages.chat_id and job_in_admin_territory(c.job_id)))
  with check (is_full_admin() and exists (select 1 from chats c where c.id = messages.chat_id and job_in_admin_territory(c.job_id)));

alter policy reviews_select on reviews using (
  exists (select 1 from chats where chats.id = reviews.chat_id
    and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid()))
  or (is_admin() and exists (select 1 from chats c where c.id = reviews.chat_id and job_in_admin_territory(c.job_id)))
);

alter policy payments_select on payments using (
  (is_admin() and job_in_admin_territory(payments.job_id))
  or exists (select 1 from jobs where jobs.id = payments.job_id and jobs.customer_id = auth.uid())
);

alter policy hauler_documents_select on hauler_documents using (
  hauler_id = auth.uid() or (is_admin() and user_in_admin_territory(hauler_documents.hauler_id))
);

alter policy cancellation_requests_select on cancellation_requests using (
  (is_admin() and job_in_admin_territory(cancellation_requests.job_id))
  or exists (select 1 from jobs where jobs.id = cancellation_requests.job_id and jobs.customer_id = auth.uid())
  or exists (select 1 from chats where chats.id = cancellation_requests.chat_id and chats.hauler_id = auth.uid())
);

alter policy admin_user_flags_select on admin_user_flags using (
  is_admin() and user_in_admin_territory(admin_user_flags.user_id)
);

alter policy account_lifecycle_audit_log_select on account_lifecycle_audit_log using (
  is_admin() and user_in_admin_territory(account_lifecycle_audit_log.target_user_id)
);

alter policy profile_change_requests_select on profile_change_requests using (
  hauler_id = auth.uid() or (is_admin() and user_in_admin_territory(profile_change_requests.hauler_id))
);

alter policy support_requests_select on support_requests using (
  (is_admin() and job_in_admin_territory(support_requests.job_id))
  or exists (select 1 from jobs where jobs.id = support_requests.job_id and jobs.customer_id = auth.uid())
  or exists (select 1 from chats where chats.id = support_requests.chat_id and chats.hauler_id = auth.uid())
);
alter policy chat_admin_sessions_select on chat_admin_sessions using (
  is_admin() and exists (select 1 from chats c where c.id = chat_admin_sessions.chat_id and job_in_admin_territory(c.job_id))
);
alter policy chat_admin_audit_log_select on chat_admin_audit_log using (
  is_admin() and exists (select 1 from chats c where c.id = chat_admin_audit_log.chat_id and job_in_admin_territory(c.job_id))
);

-- ─── 5. RPC scoping — one added territory check per function, alongside its existing is_full_admin()/is_admin() gate ──

create or replace function review_hauler_document(p_document_id uuid, p_approved boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_doc hauler_documents%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can review verification documents';
  end if;

  select * into v_doc from hauler_documents where id = p_document_id for update;
  if v_doc.id is null then
    raise exception 'Document not found';
  end if;
  if not user_in_admin_territory(v_doc.hauler_id) then
    raise exception 'This hauler is outside your assigned territory.';
  end if;

  if p_approved and v_doc.expires_at <= current_date then
    raise exception 'This document has already expired — ask the hauler to submit a current one.';
  end if;

  update hauler_documents set
    status = case when p_approved then 'approved' else 'rejected' end,
    reviewer_note = p_note,
    reviewed_by = auth.uid(),
    reviewed_at = now()
  where id = p_document_id;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    license_active = case when v_doc.doc_type = 'license' then p_approved else license_active end,
    insurance_active = case when v_doc.doc_type = 'insurance' then p_approved else insurance_active end
  where id = v_doc.hauler_id;
end;
$$;

create or replace function resolve_cancellation(p_request_id uuid, p_refund_amount numeric, p_retained_amount numeric, p_refunds jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req cancellation_requests%rowtype;
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_refund jsonb;
  v_notif_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve cancellation requests';
  end if;

  select * into v_req from cancellation_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Cancellation request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been resolved';
  end if;
  if not job_in_admin_territory(v_req.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;

  select * into v_job from jobs where id = v_req.job_id for update;
  select * into v_chat from chats where id = v_req.chat_id;

  for v_refund in select * from jsonb_array_elements(p_refunds)
  loop
    insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
    values (v_req.job_id, v_req.chat_id, (v_refund->>'amount')::numeric, 'succeeded', 'refund', v_refund->>'stripe_payment_intent_id');
  end loop;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set status = 'cancelled' where id = v_req.job_id;

  update cancellation_requests set
    status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
    refund_amount = p_refund_amount, retained_amount = p_retained_amount
  where id = p_request_id;

  insert into messages (chat_id, sender_role, text)
  values (v_req.chat_id, 'system', format('This job was cancelled by MyTrashBid. $%s was refunded to the customer.%s',
    p_refund_amount, case when p_retained_amount > 0 then format(' $%s was retained.', p_retained_amount) else '' end));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.customer_id, 'jobCancelled', 'Job cancelled', v_job.title, v_req.job_id, v_req.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.hauler_id, 'jobCancelled', 'Job cancelled', v_job.title, v_req.job_id, v_req.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;

create or replace function admin_flag_user(p_user_id uuid, p_reason_type text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_target_role text;
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can flag a user.';
  end if;
  if p_reason_type not in ('circumvention', 'cancellation_pattern', 'other') then
    raise exception 'Invalid reason type.';
  end if;

  select role into v_target_role from profiles where id = p_user_id;
  if v_target_role is null then
    raise exception 'User not found.';
  end if;
  if v_target_role = 'admin' then
    raise exception 'Admin accounts cannot be flagged.';
  end if;
  if not user_in_admin_territory(p_user_id) then
    raise exception 'This account is outside your assigned territory.';
  end if;

  insert into admin_user_flags (user_id, flagged_by, reason_type, note)
    values (p_user_id, auth.uid(), p_reason_type, nullif(trim(p_note), ''))
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function admin_resolve_user_flag(p_flag_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_user_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can resolve a flag.';
  end if;

  select user_id into v_target_user_id from admin_user_flags where id = p_flag_id;
  if v_target_user_id is null then
    raise exception 'Flag not found.';
  end if;
  if not user_in_admin_territory(v_target_user_id) then
    raise exception 'This account is outside your assigned territory.';
  end if;

  update admin_user_flags set resolved_at = now(), resolved_by = auth.uid()
    where id = p_flag_id and resolved_at is null;
end;
$$;

create or replace function admin_suspend_user(p_user_id uuid, p_reason text, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can suspend an account.'; end if;
  perform require_aal2();
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if v_profile.role = 'admin' then raise exception 'Admin accounts cannot be suspended here.'; end if;
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
  if v_profile.status = 'suspended' then raise exception 'This account is already suspended.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'suspended', suspended_at = now(), suspended_by_admin_id = auth.uid(), suspension_reason = p_reason
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'suspended', v_profile.status, 'suspended',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;

create or replace function admin_restore_user(p_user_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can restore an account.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
  if v_profile.status <> 'suspended' then raise exception 'This account is not currently suspended.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'active', suspended_at = null, suspended_by_admin_id = null, suspension_reason = null
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'restored', 'suspended', 'active',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;

create or replace function admin_set_bidding_restricted(
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
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set bidding_restricted = p_restricted where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'bidding_restricted_set', null, null,
    p_reason, jsonb_build_object('restricted', p_restricted), false, null, null, p_client_user_agent);
end;
$$;

create or replace function admin_set_posting_restricted(
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
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set posting_restricted = p_restricted where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'posting_restricted_set', null, null,
    p_reason, jsonb_build_object('restricted', p_restricted), false, null, null, p_client_user_agent);
end;
$$;

create or replace function admin_start_deletion(
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
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
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

create or replace function admin_cancel_pending_deletion(
  p_user_id uuid, p_reason text default null, p_client_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can cancel a pending deletion.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
  if v_profile.status <> 'deletion_requested' then raise exception 'There is no pending deletion request on this account.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'active', deletion_requested_at = null, deletion_reason = null, deletion_scheduled_for = null
  where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'deletion_cancelled_admin', 'deletion_requested', 'active',
    p_reason, null, false, null, null, p_client_user_agent);
  perform dispatch_account_deletion_email(p_user_id, 'cancelled');
end;
$$;

create or replace function admin_anonymize_now(
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
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
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
  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'anonymized', v_previous_status, 'anonymized', p_reason, v_blockers,
    p_force and v_blockers is not null, null, null, p_client_user_agent);
end;
$$;

create or replace function admin_mark_deleted(p_user_id uuid, p_reason text default null, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile profiles%rowtype;
begin
  if not is_full_admin() then raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can do this.'; end if;
  perform require_aal2();

  select * into v_profile from profiles where id = p_user_id for update;
  if v_profile.id is null then raise exception 'User not found.'; end if;
  if not user_in_admin_territory(p_user_id) then raise exception 'This account is outside your assigned territory.'; end if;
  if v_profile.status <> 'anonymized' then raise exception 'Only an anonymized account can be marked deleted.'; end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set status = 'deleted', deleted_at = now() where id = p_user_id;

  perform log_account_lifecycle_event(p_user_id, auth.uid(), 'marked_deleted', 'anonymized', 'deleted',
    p_reason, null, false, null, null, p_client_user_agent);
end;
$$;

create or replace function approve_profile_change_request(p_request_id uuid, p_note text default null)
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
  if not user_in_admin_territory(v_req.hauler_id) then
    raise exception 'This hauler is outside your assigned territory.';
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

create or replace function deny_profile_change_request(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_hauler_id uuid;
begin
  if not is_admin() then
    raise exception 'Only admins can deny profile change requests';
  end if;

  select hauler_id into v_hauler_id from profile_change_requests where id = p_request_id and status = 'pending';
  if v_hauler_id is null then
    raise exception 'This request is not pending';
  end if;
  if not user_in_admin_territory(v_hauler_id) then
    raise exception 'This hauler is outside your assigned territory.';
  end if;

  update profile_change_requests set
    status = 'denied', resolved_at = now(), resolved_by = auth.uid(), admin_note = p_note
  where id = p_request_id and status = 'pending';
end;
$$;

create or replace function admin_join_chat(p_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can join a conversation';
  end if;

  select * into v_chat from chats where id = p_chat_id for update;
  if v_chat.id is null then
    raise exception 'Chat not found';
  end if;
  if not job_in_admin_territory(v_chat.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;
  if exists (select 1 from chat_admin_sessions where chat_id = p_chat_id and admin_id = auth.uid() and left_at is null) then
    raise exception 'You have already joined this conversation';
  end if;

  insert into chat_admin_sessions (chat_id, admin_id) values (p_chat_id, auth.uid());

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set
    support_status = case when support_status in ('none', 'requested') then 'active' else support_status end,
    assigned_admin_id = coalesce(assigned_admin_id, auth.uid())
  where id = p_chat_id;

  insert into chat_admin_audit_log (chat_id, admin_id, action) values (p_chat_id, auth.uid(), 'join');

  insert into messages (chat_id, sender_role, text)
  values (p_chat_id, 'system', 'A MyTrashBid support representative has joined this conversation.');

  perform notify_both_parties(p_chat_id, 'adminJoined', 'Support joined your conversation',
    'A MyTrashBid team member has joined to help.');
end;
$$;

create or replace function admin_leave_chat(p_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_session_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can leave a conversation';
  end if;
  if not job_in_admin_territory((select job_id from chats where id = p_chat_id)) then
    raise exception 'This job is outside your assigned territory.';
  end if;

  select id into v_session_id from chat_admin_sessions
    where chat_id = p_chat_id and admin_id = auth.uid() and left_at is null for update;
  if v_session_id is null then
    raise exception 'You have not joined this conversation';
  end if;

  update chat_admin_sessions set left_at = now() where id = v_session_id;

  insert into chat_admin_audit_log (chat_id, admin_id, action) values (p_chat_id, auth.uid(), 'leave');

  insert into messages (chat_id, sender_role, text)
  values (p_chat_id, 'system', 'The MyTrashBid support representative has left this conversation.');
end;
$$;

create or replace function admin_lock_chat(p_chat_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can lock a conversation';
  end if;

  select * into v_chat from chats where id = p_chat_id for update;
  if v_chat.id is null then
    raise exception 'Chat not found';
  end if;
  if not job_in_admin_territory(v_chat.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;
  if v_chat.admin_locked_at is not null then
    raise exception 'This conversation is already locked';
  end if;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set admin_locked_at = now(), admin_locked_by = auth.uid() where id = p_chat_id;

  insert into chat_admin_audit_log (chat_id, admin_id, action, detail) values (p_chat_id, auth.uid(), 'lock', p_reason);

  insert into messages (chat_id, sender_role, text)
  values (p_chat_id, 'system', 'MyTrashBid support locked this conversation.');

  perform notify_both_parties(p_chat_id, 'chatLocked', 'Your conversation was locked',
    'MyTrashBid support has locked this conversation while a support matter is reviewed.');
end;
$$;

create or replace function admin_unlock_chat(p_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can unlock a conversation';
  end if;

  select * into v_chat from chats where id = p_chat_id for update;
  if v_chat.id is null then
    raise exception 'Chat not found';
  end if;
  if not job_in_admin_territory(v_chat.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;
  if v_chat.admin_locked_at is null then
    raise exception 'This conversation is not locked';
  end if;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set admin_locked_at = null, admin_locked_by = null where id = p_chat_id;

  insert into chat_admin_audit_log (chat_id, admin_id, action) values (p_chat_id, auth.uid(), 'unlock');

  insert into messages (chat_id, sender_role, text)
  values (p_chat_id, 'system', 'MyTrashBid support unlocked this conversation.');

  perform notify_both_parties(p_chat_id, 'chatUnlocked', 'Your conversation was unlocked',
    'MyTrashBid support has unlocked this conversation — you can message each other again.');
end;
$$;

create or replace function admin_resolve_support(p_request_id uuid, p_resolution_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req support_requests%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve a support request';
  end if;

  select * into v_req from support_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Support request not found';
  end if;
  if not job_in_admin_territory(v_req.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been resolved';
  end if;

  update support_requests set
    status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution_note = p_resolution_note
  where id = p_request_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set support_status = 'resolved' where id = v_req.chat_id;

  insert into chat_admin_audit_log (chat_id, admin_id, action, detail) values (v_req.chat_id, auth.uid(), 'resolve_support', p_resolution_note);

  insert into messages (chat_id, sender_role, text)
  values (v_req.chat_id, 'system', 'MyTrashBid support marked this support request as resolved.');

  perform notify_both_parties(v_req.chat_id, 'supportResolved', 'Support request resolved',
    'Your support request has been resolved by MyTrashBid.');
end;
$$;

create or replace function admin_reopen_support(p_chat_id uuid, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
  v_request_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can reopen a support request';
  end if;

  select * into v_chat from chats where id = p_chat_id;
  if v_chat.id is null then
    raise exception 'Chat not found';
  end if;
  if not job_in_admin_territory(v_chat.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;
  if exists (select 1 from support_requests where chat_id = p_chat_id and status = 'pending') then
    raise exception 'A support request is already open for this conversation';
  end if;

  insert into support_requests (job_id, chat_id, requested_by, requested_role, reason, status)
  values (v_chat.job_id, p_chat_id, auth.uid(), 'admin', p_note, 'pending')
  returning id into v_request_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set support_status = 'active' where id = p_chat_id;

  insert into chat_admin_audit_log (chat_id, admin_id, action, detail) values (p_chat_id, auth.uid(), 'reopen_support', p_note);

  insert into messages (chat_id, sender_role, text)
  values (p_chat_id, 'system', 'MyTrashBid support reopened this support request.');

  return v_request_id;
end;
$$;
