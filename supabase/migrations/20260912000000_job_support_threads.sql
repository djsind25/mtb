-- MyTrashBid — Per-job admin support threads
--
-- eBay-style: the customer<->hauler chat (chats/messages) stays exactly as-is, including the
-- existing admin-joins-that-chat system (20260814000000_admin_chat_participation.sql), which this
-- migration does not touch at all. This adds a SEPARATE line to support: either the customer or
-- the hauler on a job can open their own private thread with MyTrashBid support about that job,
-- distinct from each other and from the shared chat. Admin never becomes a "participant" in these
-- the way admin_join_chat() works for the shared chat — admin just reads and replies, same as any
-- other support ticket.
--
-- Extends the existing support_chats/support_messages tables (20260715184333_dashboard_support_chat.sql,
-- 20260718140000_close_support_chat.sql) rather than a parallel schema, per the instruction to reuse
-- existing chat/message structures where possible. Their RLS is already keyed on
-- `user_id = auth.uid() or is_admin()` with no reference to job_id at all, so a nullable job_id
-- column is naturally private per-user with zero RLS changes needed — a customer's job-scoped
-- thread is invisible to the hauler on the same job and vice versa, automatically.

-- ─── 1. support_chats: job scoping ─────────────────────────────────────────────────────────────

alter table support_chats
  add column job_id uuid references jobs(id),
  add column participant_role text check (participant_role in ('customer', 'hauler'));

-- "Reopen existing rather than duplicating" (spec) — one open job-scoped thread per user per job.
-- Doesn't touch the general (job_id is null) ticket path at all.
create unique index support_chats_user_job_open_key on support_chats (user_id, job_id)
  where status = 'open' and job_id is not null;

create index support_chats_job_id_idx on support_chats (job_id) where job_id is not null;

-- ─── 2. get_or_create_job_support_chat() — the only way a job-scoped thread gets created.
--    Authorizes via the same helpers bids_insert/job_updates already trust (customer_owns_job,
--    hauler_bid_on_job — the latter deliberately allows ANY hauler who ever bid on the job, not
--    just the one who won it, since an open job can have several bidders each wanting to ask
--    something before/instead of winning). Derives participant_role server-side so a client can
--    never claim the wrong role. ────────────────────────────────────────────────────────────────

create function get_or_create_job_support_chat(p_job_id uuid) returns support_chats
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_chat support_chats%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  if customer_owns_job(p_job_id) then
    v_role := 'customer';
  elsif hauler_bid_on_job(p_job_id) then
    v_role := 'hauler';
  else
    raise exception 'You do not have access to this job';
  end if;

  select * into v_chat from support_chats
    where user_id = auth.uid() and job_id = p_job_id and status = 'open';
  if v_chat.id is not null then
    return v_chat;
  end if;

  insert into support_chats (user_id, job_id, participant_role)
  values (auth.uid(), p_job_id, v_role)
  returning * into v_chat;

  return v_chat;
end;
$$;
revoke execute on function get_or_create_job_support_chat(uuid) from public;
grant execute on function get_or_create_job_support_chat(uuid) to authenticated;

-- ─── 3. Notify the user when admin replies in a job-scoped thread. Deliberately scoped to
--    job_id is not null only — the general support_chats/support_messages system has never
--    notified on admin reply (no such trigger exists today), and extending that is out of scope
--    here; this only adds the behavior the spec actually asked for. ──────────────────────────────

create function support_messages_notify_job_thread() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_chat support_chats%rowtype;
  v_job_title text;
  v_notif_id uuid;
begin
  if new.sender_role <> 'admin' or new.admin_only then
    return new;
  end if;

  select * into v_chat from support_chats where id = new.support_chat_id;
  if v_chat.job_id is null then
    return new;
  end if;

  select title into v_job_title from jobs where id = v_chat.job_id;

  insert into notifications (user_id, event_type, title, body, job_id)
  values (v_chat.user_id, 'newSupportMessage',
    coalesce('New message from support — ' || v_job_title, 'New message from support'),
    left(new.text, 140), v_chat.job_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return new;
end;
$$;

create trigger support_messages_notify_job_thread after insert on support_messages
  for each row execute function support_messages_notify_job_thread();

-- ─── 4. Notification event type + default prefs (byte-for-byte copy of the latest array from
--    20260911000000_job_moderation.sql, plus newSupportMessage). ──────────────────────────────────

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered',
  'bidRevisionProposed', 'bidRevisionResolved',
  'scheduleProposed', 'scheduleConfirmed', 'coordinationNudge', 'paymentAuthorized',
  'supportRequested', 'adminJoined', 'supportResolved', 'chatLocked', 'chatUnlocked',
  'disputeOpened', 'disputeResolved', 'jobRemoved', 'jobPaused', 'newSupportMessage'
]));

alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": false,
    "jobCompleted": true,
    "reminderOverdue": false,
    "jobBooked": true,
    "jobQuestionAsked": false,
    "questionAnswered": false,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true,
    "documentExpiring": false,
    "documentExpired": true,
    "adminJoined": true,
    "supportResolved": true,
    "chatLocked": true,
    "chatUnlocked": true,
    "newSupportMessage": true
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
  },
  "pushEvents": {
    "bidReceived": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  notification_prefs, '{events,newSupportMessage}', 'true'::jsonb
)
where not (notification_prefs->'events' ? 'newSupportMessage');
