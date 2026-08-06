-- MyTrashBid — Web Push notifications (PWA Prompt 1)
--
-- Adds a third notification channel alongside email/SMS, following the exact same fire-and-forget
-- pg_net dispatch pattern as dispatch_notification_email/dispatch_notification_sms (see
-- 20260719000000_sms_notifications.sql). Unlike SMS/email, "opted in" isn't a single profile
-- column — a person can have a push subscription on more than one device/browser, so
-- push_subscriptions rows themselves ARE the opt-in record (one row per device); pushEvents in
-- notification_prefs is the per-category filter layered on top, same shape as smsEvents.
--
-- Scoped to exactly the three events the PWA prompt named: bidReceived ("new bid"), bidAccepted +
-- jobBooked ("bid accepted"), and newMessage ("new message") — the customer/hauler branches only,
-- not the admin-support branch. Other event types (Q&A, scheduling, cancellations, support chat)
-- aren't wired to push yet; adding one is the same one-line `perform dispatch_notification_push(...)`
-- next to that event's existing email dispatch call.

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_id_idx on push_subscriptions(user_id);

alter table push_subscriptions enable row level security;

create policy push_subscriptions_select on push_subscriptions for select
  to authenticated using (user_id = auth.uid());
create policy push_subscriptions_insert on push_subscriptions for insert
  to authenticated with check (user_id = auth.uid());
create policy push_subscriptions_update on push_subscriptions for update
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy push_subscriptions_delete on push_subscriptions for delete
  to authenticated using (user_id = auth.uid());
-- No policy at all for the service_role edge function — it bypasses RLS via supabaseAdmin, same
-- as every other internal dispatch function reading profiles/notifications.

-- RLS policies decide which rows; this project's tables default to zero access for any role
-- until explicitly granted (see init_schema.sql's "Table grants" section) — service_role bypasses
-- RLS but still needs this base grant, same as every other table.
grant select, insert, update, delete on push_subscriptions to authenticated;
grant all on push_subscriptions to service_role;

alter table notifications add column push_dispatched boolean not null default false;

-- New profiles start with a pushEvents map (mirrors smsEvents); backfill existing profiles the
-- same jsonb_set-into-the-nested-object way the SMS migration did, so no one's existing
-- customized prefs get clobbered.
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
  },
  "pushEvents": {
    "bidReceived": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  notification_prefs,
  '{pushEvents}',
  coalesce(notification_prefs->'pushEvents', '{}'::jsonb) ||
    '{"bidReceived": true, "bidAccepted": true, "jobBooked": true, "newMessage": true}'::jsonb
)
where not (notification_prefs ? 'pushEvents');

-- ─── Push dispatch (mirrors dispatch_notification_sms's fire-and-forget pg_net pattern) ────────
create function dispatch_notification_push(p_notification_id uuid) returns void
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
      url := v_base_url || '/send-web-push',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('notificationId', p_notification_id)
    );
  exception when others then
    raise warning 'dispatch_notification_push failed for %: %', p_notification_id, sqlerrm;
  end;
  $$;

-- ─── bids_notify_customer(): add push alongside the existing email dispatch — "new bid" ────────
create or replace function bids_notify_customer() returns trigger
  language plpgsql security definer set search_path = public as $$
  declare
    v_job jobs%rowtype;
    v_hauler_name text;
    v_notif_id uuid;
  begin
    select * into v_job from jobs where id = new.job_id;
    select coalesce(business_name, name) into v_hauler_name from profiles where id = new.hauler_id;
    insert into notifications (user_id, event_type, title, body, job_id)
      values (v_job.customer_id, 'bidReceived',
              'New bid on "' || v_job.title || '"',
              v_hauler_name || ' bid $' || new.amount, new.job_id)
      returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
    perform dispatch_notification_push(v_notif_id);
    return new;
  end;
  $$;

-- ─── accept_bid(): add push alongside email+SMS for both bidAccepted and jobBooked — "bid
-- accepted". Byte-for-byte identical to the 20260817 version otherwise. ─────────────────────────
create or replace function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric, payment_mode text)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_rate numeric;
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

  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_bid.hauler_id;
  select * into v_pb from price_breakdown(v_bid.amount, v_job.payment_mode, v_rate);

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set
    status = 'booked',
    accepted_bid_id = v_bid.id,
    accepted_at = now(),
    complete_by = now() + make_interval(days => app_config_numeric('completion_window_days')::int)
  where id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  insert into chats (
    job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode,
    coordination_deadline
  )
  values (
    p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_rate, v_job.payment_mode,
    case when v_job.payment_mode = 'full' then now() + interval '48 hours' else null end
  )
  returning id into v_chat_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat_id, 'system',
    case when v_job.payment_mode = 'full'
      then 'Once the job date is agreed upon, the payment portal opens. Payment is securely processed, and the hauler is paid after the job is confirmed complete.'
      else format('Job locked in! $%s deposit paid to MyTrashBid. The remaining $%s is paid directly to your hauler at completion.', v_pb.deposit_now, v_pb.balance_due)
    end);

  -- Deposit mode still needs a pending payment row for create-deposit-intent to attach its
  -- PaymentIntent to; full mode has nothing to charge yet, so no row until authorization.
  if v_job.payment_mode <> 'full' then
    insert into payments (job_id, chat_id, amount, status)
    values (p_job_id, v_chat_id, v_pb.deposit_now, 'requires_payment');
  end if;

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_bid.hauler_id, 'bidAccepted', 'You won a job!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
  perform dispatch_notification_push(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_job.customer_id, 'jobBooked', 'Your job is booked!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
  perform dispatch_notification_push(v_notif_id);

  return query select v_chat_id, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_bid.amount, v_job.payment_mode;
end;
$$;

-- ─── messages_notify_recipient(): add push to the customer/hauler branch only — "new message".
-- Admin/support branch deliberately left alone (out of this pass's scope). Byte-for-byte identical
-- to the 20260814 version otherwise. ─────────────────────────────────────────────────────────────
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
          perform dispatch_notification_push(v_notif_id);
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
