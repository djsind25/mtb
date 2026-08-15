-- MyTrashBid — allow multiple license/insurance documents per hauler, and make the trail permanent
--
-- Until now hauler_documents held exactly one row per (hauler_id, doc_type): a fresh upload
-- replaced the old row via upsert, and a hauler could delete a row outright
-- (hauler_documents_delete, membership_and_profile_locking migration). That meant an expired or
-- superseded document's evidence — what was actually reviewed, by whom, and when — could vanish.
-- Derek wants a real paper trail: haulers can carry more than one license/insurance document at a
-- time (e.g. renewing before the old one expires, or holding two insurance policies), every
-- document stays visible forever including after it expires, and nothing can ever delete one.

-- Multiple documents per type now need to coexist, so the old one-row-per-type constraint goes.
alter table hauler_documents drop constraint hauler_documents_hauler_id_doc_type_key;

-- No more delete path, for either the table row or its storage object — the whole point is that
-- once submitted, a document (and its review history) is permanent.
drop trigger hauler_documents_reset_on_delete on hauler_documents;
drop function reset_license_flag_on_doc_delete();
drop policy hauler_documents_delete on hauler_documents;
revoke delete on hauler_documents from authenticated;
drop policy hauler_documents_storage_delete on storage.objects;

-- license_active/insurance_active used to be maintained inline at each individual write site
-- (submit clears it, review sets it, expiry sweep clears it) — that only worked because each
-- doc_type had exactly one row, so "the current row's status" and "is this hauler verified" were
-- the same question. With multiple rows per type they're not: an approved insurance policy must
-- keep a hauler bidding-eligible even while a second, unrelated insurance upload sits pending, and
-- must only drop out when NO approved+unexpired row of that type remains (not just when one
-- particular row expires). So this becomes the one place that answers "is this hauler currently
-- verified for this doc_type," recomputed from the full set of rows after every write.
create function recompute_hauler_verification_flag(p_hauler_id uuid, p_doc_type text) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_active boolean;
begin
  select exists (
    select 1 from hauler_documents
    where hauler_id = p_hauler_id and doc_type = p_doc_type
      and status = 'approved' and expires_at > current_date
  ) into v_active;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set
    license_active = case when p_doc_type = 'license' then v_active else license_active end,
    insurance_active = case when p_doc_type = 'insurance' then v_active else insurance_active end
  where id = p_hauler_id;
end;
$$;

-- Plain insert instead of upsert-replace — every submission is now its own permanent row rather
-- than overwriting whatever was there before. A fresh pending upload no longer knocks out an
-- existing approved document of the same type (recompute finds the still-valid one and leaves the
-- flag on); it only stays off if no approved+unexpired row exists yet, same as a first-ever upload.
create or replace function submit_hauler_document(p_doc_type text, p_storage_path text, p_original_name text, p_expires_at date)
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
  returning id into v_doc_id;

  perform recompute_hauler_verification_flag(auth.uid(), p_doc_type);

  return v_doc_id;
end;
$$;

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

  perform recompute_hauler_verification_flag(v_doc.hauler_id, v_doc.doc_type);
end;
$$;

-- Expiry sweep: same recompute call, so a hauler with two approved insurance rows only drops
-- insurance_active once the last valid one actually lapses, not the first.
create or replace function check_hauler_document_expirations() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_notif_id uuid;
begin
  for r in
    select * from hauler_documents
    where status = 'approved' and expires_at <= current_date
  loop
    update hauler_documents set status = 'expired' where id = r.id;
    perform recompute_hauler_verification_flag(r.hauler_id, r.doc_type);

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
