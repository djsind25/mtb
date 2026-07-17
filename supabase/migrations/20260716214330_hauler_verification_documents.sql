-- Hauler license/insurance verification — a real system behind the "vetted/licensed/insured"
-- claims already on the marketing site (previously just a single manual `verified` checkbox with
-- nothing backing it). Haulers upload a document + its expiration date; admin reviews the actual
-- file and approves or rejects; approval unlocks bidding, rejection or expiration blocks it.

alter table profiles
  add column license_active boolean not null default false,
  add column insurance_active boolean not null default false;

-- Extends the existing self-update guard (dashboard_support_chat migration) so a hauler can't
-- just flip these on themselves — only the RPCs below (admin review, or a fresh pending upload
-- that clears a stale approval) may change them, via the same app.bypass_profile_guard flag.
create or replace function guard_profile_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_admin() or new.id is distinct from auth.uid()
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
    or (new.active and not old.active)
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- One current document per hauler per type — a fresh upload replaces the old one rather than
-- keeping history, since the old one's photo/PDF is only useful for verifying the current claim.
create table hauler_documents (
  id                   uuid primary key default gen_random_uuid(),
  hauler_id            uuid not null references profiles(id) on delete cascade,
  doc_type             text not null check (doc_type in ('license', 'insurance')),
  storage_path         text not null,
  original_name        text,
  expires_at           date not null,
  status               text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  reviewer_note        text,
  reviewed_by          uuid references profiles(id),
  reviewed_at          timestamptz,
  uploaded_at          timestamptz not null default now(),
  expiry_reminder_sent boolean not null default false,
  unique (hauler_id, doc_type)
);

alter table hauler_documents enable row level security;

create policy hauler_documents_select on hauler_documents for select using (
  hauler_id = auth.uid() or is_admin()
);

-- No insert/update policy: all writes go through submit_hauler_document()/review_hauler_document()
-- below (both security definer), since a hauler and an admin each need to write columns the
-- other must not touch (a hauler setting their own `status = 'approved'` would defeat the whole
-- point). Direct client writes to this table are therefore always rejected regardless of role.
grant select on hauler_documents to authenticated, service_role;

insert into storage.buckets (id, name, public)
values ('hauler-documents', 'hauler-documents', false)
on conflict (id) do nothing;

-- Same {owner_id}/{filename} convention as job-photos — path prefix checked against auth.uid()
-- directly here (rather than a security-definer helper like customer_owns_job) since a hauler's
-- own uploads only ever need to check against their own id, no cross-table join required.
create policy hauler_documents_storage_insert on storage.objects for insert
  with check (
    bucket_id = 'hauler-documents'
    and ((storage.foldername(name))[1])::uuid = auth.uid()
  );

create policy hauler_documents_storage_select on storage.objects for select
  using (
    bucket_id = 'hauler-documents'
    and (is_admin() or ((storage.foldername(name))[1])::uuid = auth.uid())
  );

create function submit_hauler_document(p_doc_type text, p_storage_path text, p_original_name text, p_expires_at date)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_hauler profiles%rowtype;
  v_doc_id uuid;
begin
  select * into v_hauler from profiles where id = auth.uid();
  if v_hauler.id is null or v_hauler.role <> 'hauler' then
    raise exception 'Only hauler accounts can submit verification documents';
  end if;
  if p_doc_type not in ('license', 'insurance') then
    raise exception 'Invalid document type';
  end if;
  if p_expires_at <= current_date then
    raise exception 'Expiration date must be in the future';
  end if;

  insert into hauler_documents (hauler_id, doc_type, storage_path, original_name, expires_at, status, expiry_reminder_sent)
  values (auth.uid(), p_doc_type, p_storage_path, p_original_name, p_expires_at, 'pending', false)
  on conflict (hauler_id, doc_type) do update set
    storage_path = excluded.storage_path,
    original_name = excluded.original_name,
    expires_at = excluded.expires_at,
    status = 'pending',
    reviewer_note = null,
    reviewed_by = null,
    reviewed_at = null,
    uploaded_at = now(),
    expiry_reminder_sent = false
  returning id into v_doc_id;

  -- A new submission supersedes whatever was approved before, until this one is reviewed —
  -- otherwise a hauler could keep bidding on the strength of a document that's being replaced
  -- for reasons unknown to us (e.g. the old one was actually invalid).
  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    license_active = case when p_doc_type = 'license' then false else license_active end,
    insurance_active = case when p_doc_type = 'insurance' then false else insurance_active end
  where id = auth.uid();

  return v_doc_id;
end;
$$;

-- Internal auth.uid()-based role check above is the real gate, so a broad grant is safe (a
-- non-hauler caller just gets a clean rejection) — same reasoning as review_hauler_document below.
grant execute on function submit_hauler_document(text, text, text, date) to authenticated;

create function review_hauler_document(p_document_id uuid, p_approved boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_doc hauler_documents%rowtype;
begin
  if not is_admin() then
    raise exception 'Only admins can review verification documents';
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

grant execute on function review_hauler_document(uuid, boolean, text) to authenticated;

-- Bidding now also requires both documents to be currently approved — same enforcement
-- mechanism (a bids_insert RLS check) as the existing active-account and job-still-open gates.
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
);

alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type in
  ('bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring', 'documentExpired'));

-- Daily sweep (same cron pattern as send_overdue_reminders): auto-expire anything past its date
-- (flips the profile flag off too, so an admin doesn't have to notice and do it manually) and
-- nudge haulers about documents expiring within two weeks, once per document.
create function check_hauler_document_expirations() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_notif_id uuid;
begin
  perform set_config('app.bypass_profile_guard', 'true', true);

  for r in
    select * from hauler_documents
    where status = 'approved' and expires_at <= current_date
  loop
    update hauler_documents set status = 'expired' where id = r.id;
    update profiles set
      license_active = case when r.doc_type = 'license' then false else license_active end,
      insurance_active = case when r.doc_type = 'insurance' then false else insurance_active end
    where id = r.hauler_id;

    insert into notifications (user_id, event_type, title, body)
      values (r.hauler_id, 'documentExpired',
        format('Your %s has expired', r.doc_type),
        'Upload a current one from your Account tab to keep bidding on jobs.')
      returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
  end loop;

  for r in
    select * from hauler_documents
    where status = 'approved' and not expiry_reminder_sent
      and expires_at > current_date and expires_at <= current_date + 14
  loop
    update hauler_documents set expiry_reminder_sent = true where id = r.id;

    insert into notifications (user_id, event_type, title, body)
      values (r.hauler_id, 'documentExpiring',
        format('Your %s expires soon', r.doc_type),
        format('It expires on %s — upload a renewed copy from your Account tab before then to avoid a bidding interruption.', to_char(r.expires_at, 'Mon DD, YYYY')))
      returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
  end loop;
end;
$$;

select cron.schedule('hauler-document-expirations', '0 13 * * *', $$select check_hauler_document_expirations()$$);

-- Customers need to see license/insurance status on bid rows (the "Licensed 🪪 / Insured 🛡️"
-- badges), same public-safe view other hauler-facing info is already exposed through.
create or replace view public_profiles as
  select id, role, name, business_name, avatar, verified, rating, rating_count, license_active, insurance_active
  from profiles;
