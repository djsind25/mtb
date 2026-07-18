-- MyTrashBid — job completion workflow (dual confirmation + geotagged before/after photos + admin flag)
--
-- Replaces the single hauler-only confirm_job_complete with a real two-sided flow:
--   1. Hauler uploads >=1 "before" and >=1 "after" geotagged photo, then marks the work done.
--   2. Customer acknowledges completion (or a 7-day auto-ack fallback fires if they go silent).
--   3. The job surfaces in an admin "Completed jobs" queue (hauler_done_at set, admin_reviewed_at
--      null); an admin marks it reviewed to clear it — the seam a future fund-release step hangs off.
--
-- Payment-agnostic: commission still finalizes on customer ack exactly like the old flow, so the
-- current deposit model is unchanged. No Stripe/payment changes here.

-- ─── 1. Completion state on chats + config ───────────────────────────────────────
alter table chats
  add column hauler_done_at    timestamptz,
  add column customer_ack_at   timestamptz,
  add column admin_reviewed_at timestamptz,
  add column admin_reviewed_by uuid references profiles(id);

insert into app_config (key, value) values ('ack_auto_window_days', '7')
  on conflict (key) do nothing;

-- Block clients from self-setting the new completion columns (the SECURITY DEFINER RPCs below do it
-- via the app.bypass_chat_guard flag). Extends the existing allow-list guard.
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
    or new.hauler_done_at is distinct from old.hauler_done_at
    or new.customer_ack_at is distinct from old.customer_ack_at
    or new.admin_reviewed_at is distinct from old.admin_reviewed_at
    or new.admin_reviewed_by is distinct from old.admin_reviewed_by
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- ─── 2. Predicate: does the caller own (as hauler) the chat for this job? ─────────
-- Mirrors customer_owns_job. Used by both the table and storage policies below, so it must stay
-- executable by authenticated (like customer_owns_job) — NOT revoked from public.
create function hauler_owns_chat_job(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from chats where chats.job_id = p_job_id and chats.hauler_id = auth.uid());
  $$;

-- ─── 3. Completion photos table ──────────────────────────────────────────────────
create table job_completion_photos (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  phase         text not null check (phase in ('before', 'after')),
  storage_path  text not null,
  original_name text,
  lat           numeric,   -- best-effort browser geolocation at upload; null if denied/unavailable
  lng           numeric,
  uploaded_by   uuid not null references profiles(id),
  created_at    timestamptz not null default now()
);
create index job_completion_photos_job_id_idx on job_completion_photos(job_id);

alter table job_completion_photos enable row level security;

create policy job_completion_photos_insert on job_completion_photos for insert
  with check (hauler_owns_chat_job(job_id) and uploaded_by = auth.uid());

create policy job_completion_photos_select on job_completion_photos for select
  using (is_admin() or customer_owns_job(job_id) or hauler_owns_chat_job(job_id));

create policy job_completion_photos_delete on job_completion_photos for delete
  using (hauler_owns_chat_job(job_id));

grant select, insert, delete on job_completion_photos to authenticated;
grant all on job_completion_photos to service_role;

-- ─── 4. Storage bucket for the completion photo files ────────────────────────────
-- Private. Objects stored as "{job_id}/{filename}" so policies join back via foldername[1],
-- same shape as the job-photos bucket. Hauler inserts; both parties + admin read.
insert into storage.buckets (id, name, public)
values ('completion-photos', 'completion-photos', false)
on conflict (id) do nothing;

create policy completion_photos_storage_insert on storage.objects for insert
  with check (
    bucket_id = 'completion-photos'
    and hauler_owns_chat_job(((storage.foldername(name))[1])::uuid)
  );

create policy completion_photos_storage_select on storage.objects for select
  using (
    bucket_id = 'completion-photos'
    and (
      is_admin()
      or customer_owns_job(((storage.foldername(name))[1])::uuid)
      or hauler_owns_chat_job(((storage.foldername(name))[1])::uuid)
    )
  );

create policy completion_photos_storage_delete on storage.objects for delete
  using (
    bucket_id = 'completion-photos'
    and hauler_owns_chat_job(((storage.foldername(name))[1])::uuid)
  );

-- ─── 5. Notification type ────────────────────────────────────────────────────────
alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in
    ('bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue',
     'documentExpiring', 'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage',
     'jobMarkedDone'));

-- ─── 6. RPCs ─────────────────────────────────────────────────────────────────────

-- Hauler marks the work done — requires the before/after photos to exist first.
create function hauler_mark_done(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_before int;
  v_after int;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_chat from chats where job_id = p_job_id;
  if v_chat.id is null or v_chat.hauler_id <> auth.uid() then
    raise exception 'Only the assigned hauler can mark this job complete';
  end if;
  if v_chat.hauler_done_at is not null then
    raise exception 'You have already marked this job complete';
  end if;

  select
    count(*) filter (where phase = 'before'),
    count(*) filter (where phase = 'after')
  into v_before, v_after
  from job_completion_photos where job_id = p_job_id;
  if v_before < 1 or v_after < 1 then
    raise exception 'Upload at least one before photo and one after photo before marking complete';
  end if;

  select * into v_job from jobs where id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set hauler_done_at = now() where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system',
    'Hauler marked the work complete and uploaded before/after photos. Please review and acknowledge completion.');

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (v_chat.customer_id, 'jobMarkedDone', 'Your hauler marked the job complete', v_job.title, p_job_id, v_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;
revoke execute on function hauler_mark_done(uuid) from public;
grant execute on function hauler_mark_done(uuid) to authenticated;

-- Shared completion-finalizing effect, used by both the customer ack and the auto-ack cron.
-- p_auto marks whether it was the customer or the fallback, purely for the system-message wording.
create function finalize_completion(p_chat chats, p_job jobs, p_auto boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_notif_id uuid;
begin
  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set customer_ack_at = now(), commission_status = 'earned', reviews_unlocked = true
  where id = p_chat.id;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set completed = true, completed_at = now() where id = p_job.id;

  insert into messages (chat_id, sender_role, text)
  values (p_chat.id, 'system',
    case when p_auto
      then 'Job auto-acknowledged as complete after no response from the customer. Both sides can now leave a review.'
      else 'Customer acknowledged the job as complete. Both sides can now leave a review.'
    end);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (p_chat.hauler_id, 'jobCompleted', 'Job completed — leave a review', p_job.title, p_job.id, p_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
end;
$$;
revoke execute on function finalize_completion(chats, jobs, boolean) from public;

-- Customer acknowledges the hauler's completion.
create function customer_acknowledge_completion(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_chat from chats where job_id = p_job_id;
  if v_chat.id is null or v_chat.customer_id <> auth.uid() then
    raise exception 'Only the customer can acknowledge this job';
  end if;
  if v_chat.hauler_done_at is null then
    raise exception 'The hauler has not marked this job complete yet';
  end if;
  if v_chat.customer_ack_at is not null then
    raise exception 'You have already acknowledged this job';
  end if;

  select * into v_job from jobs where id = p_job_id;
  perform finalize_completion(v_chat, v_job, false);
end;
$$;
revoke execute on function customer_acknowledge_completion(uuid) from public;
grant execute on function customer_acknowledge_completion(uuid) to authenticated;

-- Admin clears the completion from the flag queue (future fund-release hook).
create function admin_review_completion(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can review completions';
  end if;
  select * into v_chat from chats where job_id = p_job_id;
  if v_chat.id is null or v_chat.hauler_done_at is null then
    raise exception 'This job has not been marked complete';
  end if;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set admin_reviewed_at = now(), admin_reviewed_by = auth.uid() where id = v_chat.id;
end;
$$;
revoke execute on function admin_review_completion(uuid) from public;
grant execute on function admin_review_completion(uuid) to authenticated;

-- ─── 7. Auto-acknowledge fallback (cron) ─────────────────────────────────────────
create function auto_acknowledge_stale_completions() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
  v_job jobs%rowtype;
  v_window int;
  r record;
begin
  v_window := app_config_numeric('ack_auto_window_days')::int;
  for r in
    select id from chats
    where hauler_done_at is not null
      and customer_ack_at is null
      and hauler_done_at < now() - make_interval(days => v_window)
  loop
    select * into v_chat from chats where id = r.id;
    select * into v_job from jobs where id = v_chat.job_id;
    perform finalize_completion(v_chat, v_job, true);
  end loop;
end;
$$;
revoke execute on function auto_acknowledge_stale_completions() from public;

select cron.schedule('auto-acknowledge-completions', '0 12 * * *',
  $cron$select auto_acknowledge_stale_completions()$cron$);

-- ─── 8. Retire the old single-step completion ────────────────────────────────────
drop function if exists confirm_job_complete(uuid);
