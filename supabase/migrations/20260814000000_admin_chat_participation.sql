-- MyTrashBid — admin participation in the customer-hauler chat
--
-- Lets an authorized admin join a job's existing chat transparently (visible system messages on
-- join/leave), send messages every party sees, add private staff notes nobody but admins can ever
-- read, and lock/unlock the conversation — plus a "Request support" action for the customer/hauler
-- side. Extends the existing chats/messages tables rather than introducing a parallel
-- conversations/generic-messages schema, since chats/messages already work and are the system of
-- record for every other chat feature (scheduling, cancellations, reviews, off-platform flagging).
--
-- Three genuinely new tables (no existing precedent covers these):
--   support_requests      — append-only request/resolution log, same shape as cancellation_requests
--   chat_admin_sessions    — join/leave history per admin per chat ("has an admin joined yet")
--   chat_admin_audit_log   — structured record of every admin action, for review/compliance
--
-- Key rule this migration enforces server-side (not just in the UI, per the product requirement
-- that admin participation must be transparent and staff notes must never leak):
--   - messages.visibility = 'staff_only' is only ever selectable by is_admin() — the RLS policy
--     itself excludes it from every customer/hauler row, so there's no code path (API, Realtime,
--     or otherwise) where a staff note reaches a participant.
--   - An admin must have an *active* chat_admin_sessions row (joined, not yet left) before they
--     can send a participants-visible message — staff notes don't require this, since they're
--     invisible to customers/haulers regardless and joining is what makes participation visible.
--   - A locked chat (admin_locked_at set) blocks customer/hauler inserts but never admin inserts —
--     an admin can still post or unlock while locked.

-- ── 1. chats: new admin-moderation columns ──────────────────────────────────────
alter table chats
  add column support_status    text not null default 'none' check (support_status in ('none', 'requested', 'active', 'resolved')),
  add column admin_locked_at   timestamptz,
  add column admin_locked_by   uuid references profiles(id),
  add column assigned_admin_id uuid references profiles(id);

-- Extends the existing self-update guard so none of the four columns above are directly editable
-- by a customer/hauler via chats_update_own — every legitimate write goes through the RPCs below,
-- each of which sets app.bypass_chat_guard first, same as every other guarded column already does.
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
    or new.coordination_deadline is distinct from old.coordination_deadline
    or new.coordination_extended_at is distinct from old.coordination_extended_at
    or new.stalled_at is distinct from old.stalled_at
    or new.locked_service_date is distinct from old.locked_service_date
    or new.locked_final_price is distinct from old.locked_final_price
    or new.locked_proposal_id is distinct from old.locked_proposal_id
    or new.authorize_at is distinct from old.authorize_at
    or new.authorized_at is distinct from old.authorized_at
    or new.captured_at is distinct from old.captured_at
    or new.support_status is distinct from old.support_status
    or new.admin_locked_at is distinct from old.admin_locked_at
    or new.admin_locked_by is distinct from old.admin_locked_by
    or new.assigned_admin_id is distinct from old.assigned_admin_id
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

-- ── 2. messages: widen sender_role to include 'admin', add visibility ───────────
alter table messages drop constraint messages_sender_role_check;
alter table messages add constraint messages_sender_role_check
  check (sender_role in ('customer', 'hauler', 'system', 'admin'));

alter table messages add column visibility text not null default 'participants'
  check (visibility in ('participants', 'staff_only'));

-- Admin-authored messages are never auto-flagged for off-platform contact — only the two real
-- parties negotiating off-platform is the behavior this trigger exists to catch.
create or replace function messages_flag_and_notify() returns trigger
  language plpgsql as $$
  declare
    prior_flags int;
  begin
    if new.sender_role not in ('system', 'admin') and is_flaggable(new.text) then
      select count(*) into prior_flags
        from messages
        where chat_id = new.chat_id and sender_role = new.sender_role and flag_type is not null;
      new.flag_type := case when prior_flags >= 1 then 'warned-repeat' else 'warned' end;
    end if;
    return new;
  end;
  $$;

-- ── 3. New tables ────────────────────────────────────────────────────────────────
create table support_requests (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references jobs(id),
  chat_id         uuid not null references chats(id),
  requested_by    uuid not null references profiles(id),
  requested_role  text not null check (requested_role in ('customer', 'hauler', 'admin')),
  reason          text,
  status          text not null default 'pending' check (status in ('pending', 'resolved')),
  resolved_by     uuid references profiles(id),
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now()
);
create index support_requests_job_id_idx on support_requests (job_id);
create index support_requests_chat_id_idx on support_requests (chat_id);
-- One open request per chat at a time — mirrors cancellation_requests' dedup shape.
create unique index support_requests_chat_id_pending_key on support_requests (chat_id) where status = 'pending';

create table chat_admin_sessions (
  id        uuid primary key default gen_random_uuid(),
  chat_id   uuid not null references chats(id) on delete cascade,
  admin_id  uuid not null references profiles(id),
  joined_at timestamptz not null default now(),
  left_at   timestamptz
);
create index chat_admin_sessions_chat_id_idx on chat_admin_sessions (chat_id);
-- At most one currently-open session per admin per chat — "has this admin joined" is exactly
-- "does a row with left_at is null exist."
create unique index chat_admin_sessions_chat_admin_open_key on chat_admin_sessions (chat_id, admin_id) where left_at is null;

create table chat_admin_audit_log (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chats(id) on delete cascade,
  admin_id   uuid not null references profiles(id),
  action     text not null check (action in ('join', 'leave', 'lock', 'unlock', 'resolve_support', 'reopen_support', 'send_staff_note')),
  detail     text,
  created_at timestamptz not null default now()
);
create index chat_admin_audit_log_chat_id_idx on chat_admin_audit_log (chat_id);

alter table support_requests enable row level security;
alter table chat_admin_sessions enable row level security;
alter table chat_admin_audit_log enable row level security;

-- No insert/update grant on any of the three — every write goes through a security definer RPC
-- below, same shape as cancellation_requests/hauler_documents.
grant select on support_requests, chat_admin_sessions, chat_admin_audit_log to authenticated;

create policy support_requests_select on support_requests for select using (
  is_admin()
  or exists (select 1 from jobs where jobs.id = support_requests.job_id and jobs.customer_id = auth.uid())
  or exists (select 1 from chats where chats.id = support_requests.chat_id and chats.hauler_id = auth.uid())
);
create policy chat_admin_sessions_select on chat_admin_sessions for select using (is_admin());
create policy chat_admin_audit_log_select on chat_admin_audit_log for select using (is_admin());

alter publication supabase_realtime add table support_requests;

-- chats was never actually added to this publication by any prior migration (only
-- notifications/messages/bids/support_chats/support_messages were) — this feature is the first
-- one whose UI genuinely depends on live chats UPDATE delivery (the support-status/lock badges
-- in ChatThread.jsx/AdminChatViewer.jsx), so it's the first one to surface the gap. Existing
-- consumers of the chat-updates-${chatId} channel (schedule locking, coordination nudges) were
-- already silently relying on a manual production fix-up or a page refresh; this closes that gap
-- for good rather than adding a fifth thing that "happens to still need a refresh."
alter publication supabase_realtime add table chats;

-- ── 4. messages RLS: staff-only visibility, join-before-participant-send, lock enforcement ──
drop policy messages_select on messages;
create policy messages_select on messages for select using (
  (visibility = 'participants'
    and exists (select 1 from chats where chats.id = messages.chat_id
      and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid())))
  or is_admin()
);

drop policy messages_insert on messages;
create policy messages_insert on messages for insert with check (
  is_active_user() and (
    (sender_role in ('customer', 'hauler') and visibility = 'participants'
      and exists (select 1 from chats where chats.id = messages.chat_id
        and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid())
        and chats.admin_locked_at is null))
    or (sender_role = 'admin' and sender_id = auth.uid() and visibility = 'staff_only' and is_full_admin())
    or (sender_role = 'admin' and sender_id = auth.uid() and visibility = 'participants' and is_full_admin()
      and exists (select 1 from chat_admin_sessions
        where chat_id = messages.chat_id and admin_id = auth.uid() and left_at is null))
  )
);

-- ── 5. Notification event types ─────────────────────────────────────────────────
alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered',
  'bidRevisionProposed', 'bidRevisionResolved',
  'scheduleProposed', 'scheduleConfirmed', 'coordinationNudge', 'paymentAuthorized',
  'supportRequested', 'adminJoined', 'supportResolved', 'chatLocked', 'chatUnlocked'
]));

-- notification_prefs: 4 new customer/hauler-facing event keys (email only, no SMS templates for
-- these — see send-sms-notification/index.ts). supportRequested isn't here at all: its only
-- recipients are admins, who have no notification-preferences UI in this app.
alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": true,
    "jobCompleted": true,
    "reminderOverdue": true,
    "jobBooked": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true,
    "adminJoined": true,
    "supportResolved": true,
    "chatLocked": true,
    "chatUnlocked": true
  },
  "smsEvents": {
    "newJobNearby": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true,
    "adminMessage": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  notification_prefs,
  '{events}',
  coalesce(notification_prefs->'events', '{}'::jsonb) ||
    '{"adminJoined": true, "supportResolved": true, "chatLocked": true, "chatUnlocked": true}'::jsonb
);

-- ── 6. Actively-viewing suppression helper ──────────────────────────────────────
-- Reuses the existing customer_last_read_at/hauler_last_read_at columns (already written by
-- markChatRead() whenever ChatThread mounts) as a best-effort proxy for "is looking at this
-- conversation right now" — this app has no real presence/online tracking anywhere, and building
-- one is out of scope for this feature.
create function recently_active(p_last_read_at timestamptz) returns boolean
  language sql immutable as $$
    select p_last_read_at is not null and now() - p_last_read_at < interval '60 seconds';
  $$;

-- Shared "notify both parties, email + in-app only, skip whoever's actively viewing" helper —
-- used by every new admin-moderation RPC below (join, lock, unlock, resolve) so that repeated
-- logic doesn't get re-typed four times.
create function notify_both_parties(p_chat_id uuid, p_event_type text, p_title text, p_body text) returns void
  language plpgsql security definer set search_path = public as $$
  declare
    v_chat chats%rowtype;
    v_notif_id uuid;
  begin
    select * into v_chat from chats where id = p_chat_id;
    if not recently_active(v_chat.customer_last_read_at) then
      insert into notifications (user_id, event_type, title, body, job_id, chat_id)
        values (v_chat.customer_id, p_event_type, p_title, p_body, v_chat.job_id, p_chat_id)
        returning id into v_notif_id;
      perform dispatch_notification_email(v_notif_id);
    end if;
    if not recently_active(v_chat.hauler_last_read_at) then
      insert into notifications (user_id, event_type, title, body, job_id, chat_id)
        values (v_chat.hauler_id, p_event_type, p_title, p_body, v_chat.job_id, p_chat_id)
        returning id into v_notif_id;
      perform dispatch_notification_email(v_notif_id);
    end if;
  end;
  $$;

-- ── 7. messages_notify_recipient(): admin branch + staff-only skip + viewing suppression ──
-- Adds a third sender branch (admin -> both parties, reusing the existing adminMessage event
-- type/SMS template from the unrelated support-ticket feature) and applies the same
-- recently_active() gate to the two existing customer/hauler branches. Streak-throttled SMS
-- (only the first message of a run from "the other side" texts, not every reply) is unchanged in
-- spirit — computed once from the immediately-prior message's sender_role, same as before.
create or replace function messages_notify_recipient() returns trigger
  language plpgsql security definer set search_path = public as $$
  declare
    v_chat chats%rowtype;
    v_notif_id uuid;
    v_prev_sender text;
    v_fresh_streak boolean;
  begin
    if new.sender_role = 'system' or new.visibility = 'staff_only' then
      return new;
    end if;
    select * into v_chat from chats where id = new.chat_id;

    select sender_role into v_prev_sender from messages
      where chat_id = new.chat_id and id <> new.id
      order by created_at desc, id desc limit 1;
    v_fresh_streak := v_prev_sender is null or v_prev_sender <> new.sender_role;

    if new.sender_role in ('customer', 'hauler') then
      declare
        v_recipient uuid := case when new.sender_role = 'customer' then v_chat.hauler_id else v_chat.customer_id end;
        v_recipient_last_read timestamptz := case when new.sender_role = 'customer' then v_chat.hauler_last_read_at else v_chat.customer_last_read_at end;
      begin
        if not recently_active(v_recipient_last_read) then
          insert into notifications (user_id, event_type, title, body, job_id, chat_id)
            values (v_recipient, 'newMessage', 'New message', left(new.text, 140), v_chat.job_id, v_chat.id)
            returning id into v_notif_id;
          perform dispatch_notification_email(v_notif_id);
          if v_fresh_streak then
            perform dispatch_notification_sms(v_notif_id);
          end if;
        end if;
      end;
    elsif new.sender_role = 'admin' then
      if not recently_active(v_chat.customer_last_read_at) then
        insert into notifications (user_id, event_type, title, body, job_id, chat_id)
          values (v_chat.customer_id, 'adminMessage', 'New message from MyTrashBid support', left(new.text, 140), v_chat.job_id, v_chat.id)
          returning id into v_notif_id;
        perform dispatch_notification_email(v_notif_id);
        if v_fresh_streak then
          perform dispatch_notification_sms(v_notif_id);
        end if;
      end if;
      if not recently_active(v_chat.hauler_last_read_at) then
        insert into notifications (user_id, event_type, title, body, job_id, chat_id)
          values (v_chat.hauler_id, 'adminMessage', 'New message from MyTrashBid support', left(new.text, 140), v_chat.job_id, v_chat.id)
          returning id into v_notif_id;
        perform dispatch_notification_email(v_notif_id);
        if v_fresh_streak then
          perform dispatch_notification_sms(v_notif_id);
        end if;
      end if;
    end if;

    return new;
  end;
  $$;

-- ── 8. RPCs ──────────────────────────────────────────────────────────────────────

-- Either the customer or hauler on the job's active chat can ask for support. Dedup'd the same
-- way cancellation_requests is (explicit exists() check + a partial unique index backstop).
create function request_chat_support(p_job_id uuid, p_reason text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
  v_role text;
  v_request_id uuid;
  v_admin record;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null for update;
  if v_chat.id is null then
    raise exception 'No active chat for this job';
  end if;

  if v_chat.customer_id = auth.uid() then
    v_role := 'customer';
  elsif v_chat.hauler_id = auth.uid() then
    v_role := 'hauler';
  else
    raise exception 'Only the customer or hauler on this job can request support';
  end if;

  if exists (select 1 from support_requests where chat_id = v_chat.id and status = 'pending') then
    raise exception 'Support has already been requested for this conversation';
  end if;

  insert into support_requests (job_id, chat_id, requested_by, requested_role, reason)
  values (p_job_id, v_chat.id, auth.uid(), v_role, p_reason)
  returning id into v_request_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set support_status = 'requested' where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('%s requested support from MyTrashBid.%s',
    case when v_role = 'customer' then 'The customer' else 'The hauler' end,
    case when p_reason is not null and p_reason <> '' then format(' Reason: "%s"', p_reason) else '' end));

  for v_admin in select id from profiles where role = 'admin' loop
    insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (v_admin.id, 'supportRequested', 'Support requested',
      format('A job chat needs support — %s requested help.', case when v_role = 'customer' then 'the customer' else 'the hauler' end),
      p_job_id, v_chat.id)
    returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
    perform dispatch_notification_sms(v_notif_id);
  end loop;

  return v_request_id;
end;
$$;
revoke execute on function request_chat_support(uuid, text) from public;
grant execute on function request_chat_support(uuid, text) to authenticated;

create function admin_join_chat(p_chat_id uuid) returns void
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
revoke execute on function admin_join_chat(uuid) from public;
grant execute on function admin_join_chat(uuid) to authenticated;

create function admin_leave_chat(p_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_session_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can leave a conversation';
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
revoke execute on function admin_leave_chat(uuid) from public;
grant execute on function admin_leave_chat(uuid) to authenticated;

create function admin_lock_chat(p_chat_id uuid, p_reason text default null) returns void
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
revoke execute on function admin_lock_chat(uuid, text) from public;
grant execute on function admin_lock_chat(uuid, text) to authenticated;

create function admin_unlock_chat(p_chat_id uuid) returns void
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
revoke execute on function admin_unlock_chat(uuid) from public;
grant execute on function admin_unlock_chat(uuid) to authenticated;

create function admin_resolve_support(p_request_id uuid, p_resolution_note text default null) returns void
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
revoke execute on function admin_resolve_support(uuid, text) from public;
grant execute on function admin_resolve_support(uuid, text) to authenticated;

-- Append-only, same as request_chat_support: reopening never mutates the old (resolved) row —
-- it inserts a fresh 'pending' request, so the resolution history of the earlier one is preserved.
create function admin_reopen_support(p_chat_id uuid, p_note text default null) returns uuid
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
revoke execute on function admin_reopen_support(uuid, text) from public;
grant execute on function admin_reopen_support(uuid, text) to authenticated;
