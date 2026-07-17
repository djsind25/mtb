-- MyTrashBid — view-only admin role
--
-- Lets an admin account be marked read-only: same full visibility as any admin (every RLS select
-- policy already uses is_admin(), unchanged), but blocked from every mutating action — editing or
-- deactivating a user, approving/rejecting hauler documents, marking a flag/overdue job reviewed,
-- or replying to a support ticket. Existing admins default to full access.

alter table profiles add column admin_read_only boolean not null default false;

-- is_admin() keeps gating every *read* path exactly as before. This new function additionally
-- gates every *write* path (RLS insert/update/delete policies, mutating RPCs, and the self-update
-- guard triggers' admin bypass) — a view-only admin passes is_admin() but fails is_full_admin().
create function is_full_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and not admin_read_only);
  $$;

-- ── profiles: admin editing another user's row (EditUserModal save, deactivate/reactivate,
-- and toggling another admin's admin_read_only flag) ──
drop policy profiles_update_own on profiles;
create policy profiles_update_own on profiles for update
  using (id = auth.uid() or is_full_admin())
  with check (id = auth.uid() or is_full_admin());

-- ── zip_geo / app_config admin write ──
drop policy zip_geo_admin_write on zip_geo;
create policy zip_geo_admin_write on zip_geo for all using (is_full_admin()) with check (is_full_admin());
drop policy app_config_admin_write on app_config;
create policy app_config_admin_write on app_config for all using (is_full_admin()) with check (is_full_admin());

-- ── jobs: admin edits (also gates the overdue_reviewed toggle) ──
drop policy jobs_update_own on jobs;
create policy jobs_update_own on jobs for update using (customer_id = auth.uid() or is_full_admin());

-- ── messages: flag_reviewed toggle ──
drop policy messages_update_admin on messages;
create policy messages_update_admin on messages for update using (is_full_admin()) with check (is_full_admin());

-- ── support chats: admin replies + closing tickets ──
drop policy support_chats_update on support_chats;
create policy support_chats_update on support_chats for update using (
  user_id = auth.uid() or is_full_admin()
);
drop policy support_messages_insert on support_messages;
create policy support_messages_insert on support_messages for insert with check (
  exists (select 1 from support_chats sc where sc.id = support_chat_id and (sc.user_id = auth.uid() or is_full_admin()))
);

-- ── chats: no UI exposes an admin-direct edit today, kept consistent as defense-in-depth ──
drop policy chats_update_own on chats;
create policy chats_update_own on chats for update using (
  customer_id = auth.uid() or hauler_id = auth.uid() or is_full_admin()
);

-- ── hauler_documents: the actual approve/reject action ──
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

-- ── self-update guard triggers: admin bypass now requires full admin ──
create or replace function guard_profile_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or new.id is distinct from auth.uid()
    or coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true'
  then
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
    or (new.active and not old.active)
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

create or replace function guard_chat_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or coalesce(current_setting('app.bypass_chat_guard', true), '') = 'true' then
    return new;
  end if;
  if new.bid_amount is distinct from old.bid_amount
    or new.deposit is distinct from old.deposit
    or new.balance_due is distinct from old.balance_due
    or new.commission is distinct from old.commission
    or new.commission_status is distinct from old.commission_status
    or new.payment_mode is distinct from old.payment_mode
    or new.reviews_unlocked is distinct from old.reviews_unlocked
    or new.job_id is distinct from old.job_id
    or new.customer_id is distinct from old.customer_id
    or new.hauler_id is distinct from old.hauler_id
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

create or replace function guard_job_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or auth.role() = 'service_role'
    or coalesce(current_setting('app.bypass_job_guard', true), '') = 'true'
  then
    return new;
  end if;

  if old.status = 'booked' and new.timeline is distinct from old.timeline then
    raise exception 'Timeline can only be changed before a bid is accepted.';
  end if;

  if to_jsonb(new) - 'timeline' <> to_jsonb(old) - 'timeline' then
    raise exception 'Not permitted to change this field.';
  end if;

  return new;
end;
$$;
