-- MyTrashBid — SMS notifications (hauler + customer opt-in)
--
-- Phone stays a nullable column (a hard NOT NULL/check constraint would block admins from
-- editing an existing incomplete hauler's other fields) — "mandatory for haulers" is enforced
-- app-level, in the signup form and the Account tab. Texting itself is opt-in for everyone,
-- gated by profiles.sms_consent (also doubles as the compliance record via sms_consent_at,
-- set whenever consent is switched on — never cleared on opt-out, so it always shows the last
-- time this person actually agreed).
--
-- SMS event types, added to notifications.event_type below:
--   newJobNearby — hauler-only, batched into an hourly digest (not one text per job — a hauler
--                  in a busy ZIP could otherwise get dozens of texts a day)
--   jobBooked    — customer-only ("your job is booked" confirmation); also the first-ever
--                  dispatch of any kind for this event — accept_bid() previously wrote a
--                  notifications row for the hauler's bidAccepted but never actually dispatched
--                  it (a pre-existing bug, fixed below alongside adding this)
--   adminMessage — either role, when an admin replies in their support chat (no notification of
--                  any kind exists for that today for in-app "Contact Administrator" chats)
--   (existing) bidAccepted, newMessage — reused as-is, now also SMS-eligible
--
-- Chat-style events (newMessage, adminMessage) are streak-throttled: only the first message of a
-- run from "the other side" fires a text, not every back-and-forth reply — otherwise a normal
-- conversation would mean a text per message.

alter table profiles
  add column sms_consent    boolean not null default false,
  add column sms_consent_at timestamptz;

alter table notifications
  add column sms_dispatched boolean not null default false;

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in
    ('bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue',
     'documentExpiring', 'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage'));

-- New profiles start with both the email events map (unchanged) and a parallel smsEvents map —
-- a separate on/off per channel, since someone might want emails for everything but texts only
-- for a couple of these. jobBooked also joins the *email* events map below (it's a real gap —
-- customers get zero notification of any kind today when their job books) but newJobNearby does
-- not, since a real-time email per nearby job would be just as noisy as the digest is designed
-- to avoid for SMS.
alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": true,
    "jobCompleted": true,
    "reminderOverdue": true,
    "jobBooked": true
  },
  "smsEvents": {
    "newJobNearby": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true,
    "adminMessage": true
  }
}'::jsonb;

-- jsonb `||` only merges at the top level — merging straight into notification_prefs would
-- replace the whole nested "events" object and silently wipe out any per-event flags a user had
-- already customized. Build each nested object explicitly instead, merging into the *existing*
-- sub-object rather than the top-level column.
update profiles set notification_prefs = jsonb_set(
  jsonb_set(
    notification_prefs,
    '{events}',
    coalesce(notification_prefs->'events', '{}'::jsonb) || '{"jobBooked": true}'::jsonb
  ),
  '{smsEvents}',
  coalesce(notification_prefs->'smsEvents', '{}'::jsonb) ||
    '{"newJobNearby": true, "bidAccepted": true, "jobBooked": true, "newMessage": true, "adminMessage": true}'::jsonb
)
where not (notification_prefs ? 'smsEvents');

-- ─── SMS dispatch (mirrors dispatch_notification_email's fire-and-forget pg_net pattern) ──────
create function dispatch_notification_sms(p_notification_id uuid) returns void
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
      url := v_base_url || '/send-sms-notification',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('notificationId', p_notification_id)
    );
  exception when others then
    raise warning 'dispatch_notification_sms failed for %: %', p_notification_id, sqlerrm;
  end;
  $$;

-- Cron-fired, no specific notification id — the edge function itself queries for every hauler
-- with undispatched newJobNearby rows, groups them, and sends one text per hauler.
create function dispatch_new_job_sms_digest() returns void
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
      url := v_base_url || '/send-sms-notification',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('digest', true)
    );
  exception when others then
    raise warning 'dispatch_new_job_sms_digest failed: %', sqlerrm;
  end;
  $$;

select cron.schedule('new-job-sms-digest', '0 * * * *', $cron$select dispatch_new_job_sms_digest()$cron$);

-- ─── New job posted (or flips pending_verification -> open) — fan out to nearby haulers ───────
-- Deliberately stricter than list_open_jobs_for_hauler()'s browse query: that one shows jobs to
-- haulers with unknown coordinates too ("unknown distance = show anyway"); this only queues a
-- text for haulers whose distance is actually known and within radius — texting is a paid,
-- more intrusive channel than an in-app list, so an unresolvable ZIP shouldn't guess.
create function notify_nearby_haulers_of_new_job() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_radius numeric;
  r record;
begin
  if new.status <> 'open' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'open' then
    return new;
  end if;

  v_radius := app_config_numeric('max_radius_mi');

  for r in
    select p.id from profiles p
    where p.role = 'hauler' and p.active
      and p.lat is not null and p.lng is not null
      and new.lat is not null and new.lng is not null
      and earth_distance(ll_to_earth(p.lat, p.lng), ll_to_earth(new.lat, new.lng)) / 1609.34 <= v_radius
  loop
    insert into notifications (user_id, event_type, title, body, job_id)
    values (r.id, 'newJobNearby', new.title, new.zip, new.id);
  end loop;

  return new;
end;
$$;

create trigger jobs_notify_nearby_haulers_insert after insert on jobs
  for each row execute function notify_nearby_haulers_of_new_job();
create trigger jobs_notify_nearby_haulers_update after update on jobs
  for each row execute function notify_nearby_haulers_of_new_job();

-- ─── accept_bid(): fixes a pre-existing bug (bidAccepted was never actually dispatched — the
-- notifications row was written but nothing ever called dispatch_notification_email for it) and
-- adds the customer-side jobBooked confirmation (email + sms) that never existed at all ───────
create or replace function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_chat_id uuid;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> auth.uid() then
    raise exception 'Only the job owner can accept a bid';
  end if;
  if v_job.status <> 'open' then
    raise exception 'Job is not open';
  end if;

  select * into v_bid from bids where id = p_bid_id and job_id = p_job_id for update;
  if v_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_bid.expires_at <= now() then
    raise exception 'This bid has expired and can no longer be accepted';
  end if;

  select * into v_pb from price_breakdown(v_bid.amount, v_job.payment_mode);

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    status = 'booked',
    accepted_bid_id = v_bid.id,
    accepted_at = now(),
    complete_by = now() + make_interval(days => app_config_numeric('completion_window_days')::int)
  where id = p_job_id;

  insert into chats (job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode)
  values (p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_job.payment_mode)
  returning id into v_chat_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat_id, 'system',
    case when v_job.payment_mode = 'full'
      then format('Job locked in! $%s paid through MyTrashBid and held securely. $%s releases to your hauler when the job is confirmed complete.', v_pb.amount, v_pb.balance_due)
      else format('Job locked in! $%s deposit paid to MyTrashBid. The remaining $%s is paid directly to your hauler at completion.', v_pb.deposit_now, v_pb.balance_due)
    end);

  insert into payments (job_id, chat_id, amount, status)
  values (p_job_id, v_chat_id, v_pb.deposit_now, 'requires_payment');

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_bid.hauler_id, 'bidAccepted', 'You won a job!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_job.customer_id, 'jobBooked', 'Your job is booked!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return query select v_chat_id, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_bid.amount;
end;
$$;

-- ─── messages_notify_recipient(): add streak-throttled SMS alongside the existing email dispatch ──
create or replace function messages_notify_recipient() returns trigger
  language plpgsql security definer set search_path = public as $$
  declare
    v_chat chats%rowtype;
    v_recipient uuid;
    v_notif_id uuid;
    v_prev_sender text;
  begin
    if new.sender_role = 'system' then
      return new;
    end if;
    select * into v_chat from chats where id = new.chat_id;
    v_recipient := case when new.sender_role = 'customer' then v_chat.hauler_id else v_chat.customer_id end;
    insert into notifications (user_id, event_type, title, body, job_id, chat_id)
      values (v_recipient, 'newMessage', 'New message', left(new.text, 140), v_chat.job_id, v_chat.id)
      returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);

    select sender_role into v_prev_sender from messages
      where chat_id = new.chat_id and id <> new.id
      order by created_at desc, id desc limit 1;
    if v_prev_sender is null or v_prev_sender <> new.sender_role then
      perform dispatch_notification_sms(v_notif_id);
    end if;

    return new;
  end;
  $$;

-- ─── assign_support_chat_on_admin_reply(): add the adminMessage SMS path for real accounts
-- (guest/email-only threads already get emailed via dispatch_support_reply_email above; this is
-- additive for the in-app "Contact Administrator" case that previously notified no one) ────────
create or replace function assign_support_chat_on_admin_reply() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid;
  v_notif_id uuid;
  v_prev_sender text;
begin
  if new.sender_role = 'admin' then
    update support_chats set assigned_admin_id = new.sender_id
      where id = new.support_chat_id and assigned_admin_id is null;
    perform dispatch_support_reply_email(new.id);

    select user_id into v_user_id from support_chats where id = new.support_chat_id;
    if v_user_id is not null then
      select sender_role into v_prev_sender from support_messages
        where support_chat_id = new.support_chat_id and id <> new.id
        order by created_at desc, id desc limit 1;
      if v_prev_sender is null or v_prev_sender <> 'admin' then
        insert into notifications (user_id, event_type, title, body)
        values (v_user_id, 'adminMessage', 'New message from MyTrashBid support', left(new.text, 140))
        returning id into v_notif_id;
        perform dispatch_notification_sms(v_notif_id);
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- ─── handle_new_user(): capture phone + sms consent from signup metadata ──────────────────────
create or replace function handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_profile_id uuid;
  v_sms_consent boolean;
begin
  v_role := new.raw_user_meta_data->>'role';
  if v_role is null or v_role not in ('customer', 'hauler') then
    v_role := 'customer';
  end if;
  v_sms_consent := coalesce((new.raw_user_meta_data->>'sms_consent')::boolean, false);

  insert into profiles (id, role, email, name, business_name, zip, phone, sms_consent, sms_consent_at, email_verify_token)
  values (
    new.id,
    v_role,
    new.email,
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'business_name',
    coalesce(new.raw_user_meta_data->>'zip', ''),
    nullif(new.raw_user_meta_data->>'phone', ''),
    v_sms_consent,
    case when v_sms_consent then now() else null end,
    encode(extensions.gen_random_bytes(24), 'hex')
  )
  on conflict (id) do nothing
  returning id into v_profile_id;

  if v_profile_id is not null then
    perform dispatch_verification_email(v_profile_id);
  end if;

  return new;
end;
$$;
