-- MyTrashBid — core schema
-- Ports the prototype's data model (users, jobs, bids, chats, messages, reviews, flags)
-- into real Postgres tables with row-level security. Mirrors junk-bids-platform-full.jsx.

create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists cube;          -- required by earthdistance
create extension if not exists earthdistance; -- great-circle distance for radius matching
create extension if not exists pg_net;        -- async HTTP calls from triggers, to the send-notification function

-- ─── App-wide tunables (single source of truth, matches the prototype's named constants) ──
-- LIVE_WINDOW_MS, COMPLETION_WINDOW_MS, MAX_RADIUS_MI, COMMISSION_RATE all live here so they
-- stay admin-configurable without a redeploy, per the Scope of Work's "single configurable
-- constant" requirement for the 50-mile radius.
create table app_config (
  key   text primary key,
  value text not null
);

insert into app_config (key, value) values
  ('live_window_days', '14'),
  ('completion_window_days', '30'),
  ('max_radius_mi', '50'),
  ('commission_rate', '0.10'),
  -- Local dev default: from *inside* the db container, 127.0.0.1 is the container itself, not
  -- the host — Kong is reachable via its Docker network alias instead. After deploying, set
  -- this to your project's real functions URL (https://<ref>.supabase.co/functions/v1) — see
  -- README "Notifications" section.
  ('functions_base_url', 'http://kong:8000/functions/v1'),
  -- Shared secret the send-notification function checks on inbound calls from Postgres.
  -- Generated randomly here; the same value must be set as INTERNAL_DISPATCH_KEY when you
  -- deploy that function (supabase secrets set INTERNAL_DISPATCH_KEY=<this value>).
  ('internal_dispatch_key', encode(extensions.gen_random_bytes(24), 'hex'));

create function app_config_numeric(p_key text) returns numeric
  language sql stable as $$
    select value::numeric from app_config where key = p_key;
  $$;

-- ─── Profiles (1:1 with auth.users) ────────────────────────────────────────────
create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  role               text not null check (role in ('customer', 'hauler', 'admin')),
  email              text not null,
  name               text,          -- customer full name, or hauler's contact name
  business_name      text,          -- hauler only
  zip                text not null default '',
  lat                numeric,
  lng                numeric,
  phone              text,
  avatar             text,
  verified           boolean not null default false,   -- hauler verification badge
  rating             numeric,
  notification_prefs jsonb not null default '{
    "email": true,
    "sms": false,
    "events": {
      "bidReceived": true,
      "bidAccepted": true,
      "newMessage": true,
      "jobCompleted": true,
      "reminderOverdue": true
    }
  }'::jsonb,
  created_at timestamptz not null default now()
);

-- Public-safe subset of profiles (name/business_name/avatar/verified) so the other side of a
-- job/bid/chat can see who they're dealing with without exposing email/phone/zip to strangers.
-- security_invoker is intentionally left at the default (definer-style) so this view can read
-- across the profiles RLS boundary while only ever projecting the limited column set below.
create view public_profiles as
  select id, role, name, business_name, avatar, verified
  from profiles;

-- ─── ZIP → lat/lng centroid table (production replacement for the prototype's embedded table) ─
-- Seeded with the prototype's Will County launch-market ZIPs in the storage_and_seed migration.
-- To cover the whole country, bulk-import a free ZIP centroid dataset (US Census / SimpleMaps)
-- into this table — the app code and radius math never change.
create table zip_geo (
  zip   text primary key,
  lat   numeric not null,
  lng   numeric not null,
  city  text,
  state text
);

-- ─── Jobs ───────────────────────────────────────────────────────────────────────
create table jobs (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references profiles(id),
  title            text not null,
  description      text,
  zip              text not null,
  lat              numeric,
  lng              numeric,
  status           text not null default 'open' check (status in ('open', 'booked')),
  accepted_bid_id  uuid,  -- FK added after bids exists (see below)
  payment_mode     text not null default 'deposit' check (payment_mode in ('deposit', 'full')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now(),  -- set for real by trigger below
  accepted_at      timestamptz,
  complete_by      timestamptz,
  completed        boolean not null default false,
  completed_at     timestamptz,
  overdue_notified boolean not null default false
);

create table job_photos (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  storage_path  text not null,
  original_name text,
  created_at    timestamptz not null default now()
);

-- ─── Bids ───────────────────────────────────────────────────────────────────────
create table bids (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs(id) on delete cascade,
  hauler_id  uuid not null references profiles(id),
  amount     numeric(10, 2) not null check (amount > 0),
  note       text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now(),  -- set for real by trigger below
  unique (job_id, hauler_id)  -- one bid per hauler per job, enforced server-side
);

alter table jobs
  add constraint jobs_accepted_bid_fk foreign key (accepted_bid_id) references bids(id);

-- ─── Chats (one per booked job) ────────────────────────────────────────────────
create table chats (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null unique references jobs(id) on delete cascade,
  customer_id        uuid not null references profiles(id),
  hauler_id          uuid not null references profiles(id),
  bid_amount         numeric(10, 2) not null,
  deposit            numeric(10, 2) not null,
  balance_due        numeric(10, 2) not null,
  commission         numeric(10, 2) not null,
  commission_status  text not null default 'held' check (commission_status in ('held', 'earned')),
  payment_mode       text not null,
  reviews_unlocked   boolean not null default false,
  created_at         timestamptz not null default now()
);

create table messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chats(id) on delete cascade,
  sender_role text not null check (sender_role in ('customer', 'hauler', 'system')),
  sender_id  uuid references profiles(id),
  text       text not null,
  flag_type  text check (flag_type in ('warned', 'warned-repeat')),
  created_at timestamptz not null default now()
);

create table reviews (
  id            uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references chats(id) on delete cascade,
  reviewer_role text not null check (reviewer_role in ('customer', 'hauler')),
  rating        int not null check (rating between 1 and 5),
  text          text,
  created_at    timestamptz not null default now(),
  unique (chat_id, reviewer_role)
);

-- ─── Payments (Stripe deposit tracking — plain PaymentIntents, no Connect) ─────
create table payments (
  id                       uuid primary key default gen_random_uuid(),
  job_id                   uuid not null references jobs(id),
  chat_id                  uuid references chats(id),
  stripe_payment_intent_id text unique,
  amount                   numeric(10, 2) not null,
  currency                 text not null default 'usd',
  status                   text not null default 'requires_payment'
                             check (status in ('requires_payment', 'processing', 'succeeded', 'failed', 'refunded', 'canceled')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ─── Notifications (in-app realtime feed; email dispatch keys off the same rows) ─
create table notifications (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  event_type       text not null check (event_type in
                     ('bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue')),
  title            text not null,
  body             text,
  job_id           uuid references jobs(id),
  chat_id          uuid references chats(id),
  read             boolean not null default false,
  email_dispatched boolean not null default false,
  created_at       timestamptz not null default now()
);

-- Fires an async, best-effort HTTP call to the send-notification Edge Function so it can
-- decide (based on the recipient's notification_prefs) whether to email them. net.http_post
-- queues the request on pg_net's background worker and returns immediately — a slow or
-- failing HTTP call never blocks the transaction that raised the notification. Wrapped in
-- its own exception handler so even a missing/misconfigured extension can't break callers.
create function dispatch_notification_email(p_notification_id uuid) returns void
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
      url := v_base_url || '/send-notification',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('notificationId', p_notification_id)
    );
  exception when others then
    raise warning 'dispatch_notification_email failed for %: %', p_notification_id, sqlerrm;
  end;
  $$;

-- ─── Indexes ────────────────────────────────────────────────────────────────────
create index jobs_customer_id_idx on jobs(customer_id);
create index jobs_status_idx on jobs(status);
create index bids_job_id_idx on bids(job_id);
create index bids_hauler_id_idx on bids(hauler_id);
create index chats_customer_id_idx on chats(customer_id);
create index chats_hauler_id_idx on chats(hauler_id);
create index messages_chat_id_idx on messages(chat_id);
create index notifications_user_id_idx on notifications(user_id);

-- ─── Triggers: server-computed expiry windows (never trust the client's clock) ──
create function set_job_expiry() returns trigger
  language plpgsql as $$
  begin
    new.expires_at := new.created_at + make_interval(days => app_config_numeric('live_window_days')::int);
    if new.zip is not null then
      select lat, lng into new.lat, new.lng from zip_geo where zip = trim(new.zip);
    end if;
    return new;
  end;
  $$;
create trigger jobs_set_expiry before insert on jobs
  for each row execute function set_job_expiry();

create function set_bid_expiry() returns trigger
  language plpgsql as $$
  begin
    new.expires_at := new.created_at + make_interval(days => app_config_numeric('live_window_days')::int);
    return new;
  end;
  $$;
create trigger bids_set_expiry before insert on bids
  for each row execute function set_bid_expiry();

create function set_profile_geo() returns trigger
  language plpgsql as $$
  begin
    if new.zip is not null and new.zip <> '' then
      select lat, lng into new.lat, new.lng from zip_geo where zip = trim(new.zip);
    end if;
    return new;
  end;
  $$;
create trigger profiles_set_geo before insert or update of zip on profiles
  for each row execute function set_profile_geo();

-- ─── Trigger: message flagging (off-platform-circumvention detection) ──────────
-- Server-side re-implementation of the prototype's isFlaggable() — the client can no longer
-- decide whether its own message gets flagged.
create function is_flaggable(p_text text) returns boolean
  language sql immutable as $$
    select p_text ~* '\d{3}[-.\s]?\d{3}[-.\s]?\d{4}'
        or p_text ~* '[\w.+-]+@[\w-]+\.[a-z]{2,}'
        or p_text ~* '\ycash\y'
        or p_text ~* '\y(venmo|zelle|paypal|cashapp)\y'
        or p_text ~* 'call me'
        or p_text ~* 'text me'
        or p_text ~* 'off.?the.?app'
        or p_text ~* 'off.?platform';
  $$;

create function messages_flag_and_notify() returns trigger
  language plpgsql as $$
  declare
    prior_flags int;
  begin
    if new.sender_role <> 'system' and is_flaggable(new.text) then
      select count(*) into prior_flags
        from messages
        where chat_id = new.chat_id and sender_role = new.sender_role and flag_type is not null;
      new.flag_type := case when prior_flags >= 1 then 'warned-repeat' else 'warned' end;
    end if;
    return new;
  end;
  $$;
create trigger messages_before_insert before insert on messages
  for each row execute function messages_flag_and_notify();

create function messages_notify_recipient() returns trigger
  language plpgsql security definer set search_path = public as $$
  declare
    v_chat chats%rowtype;
    v_recipient uuid;
    v_notif_id uuid;
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
    return new;
  end;
  $$;
create trigger messages_after_insert after insert on messages
  for each row execute function messages_notify_recipient();

-- ─── Trigger: notify customer when a new bid lands ─────────────────────────────
create function bids_notify_customer() returns trigger
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
    return new;
  end;
  $$;
create trigger bids_after_insert after insert on bids
  for each row execute function bids_notify_customer();

-- ─── updated_at bookkeeping for payments ───────────────────────────────────────
create function touch_updated_at() returns trigger
  language plpgsql as $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;
create trigger payments_touch_updated_at before update on payments
  for each row execute function touch_updated_at();

-- ─── Row Level Security ─────────────────────────────────────────────────────────
alter table profiles enable row level security;
alter table jobs enable row level security;
alter table job_photos enable row level security;
alter table bids enable row level security;
alter table chats enable row level security;
alter table messages enable row level security;
alter table reviews enable row level security;
alter table payments enable row level security;
alter table notifications enable row level security;
alter table zip_geo enable row level security;
alter table app_config enable row level security;

create function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
  $$;

-- jobs_select and bids_select each need to check the *other* table (a hauler can see a job
-- once they've bid on it; a customer can see bids on their own job). Doing that with a plain
-- EXISTS subquery on the other table makes each policy re-evaluate the other's RLS, which
-- re-evaluates the first again — infinite recursion. These SECURITY DEFINER helpers run as
-- the (RLS-bypassing) table owner, so the cross-check never re-enters either policy.
create function hauler_bid_on_job(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from bids where bids.job_id = p_job_id and bids.hauler_id = auth.uid());
  $$;
create function customer_owns_job(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from jobs where jobs.id = p_job_id and jobs.customer_id = auth.uid());
  $$;

-- A hauler placing their *first* bid on a job can't SELECT it yet under jobs_select (that
-- policy only grants visibility once a bid exists — see below) so bids_insert's own "is this
-- job open" check has to bypass RLS the same way, or no hauler could ever place a first bid.
create function job_is_open_for_bid(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (select 1 from jobs where jobs.id = p_job_id and jobs.status = 'open' and jobs.expires_at > now());
  $$;

-- profiles: everyone manages their own row; admin sees/edits all.
create policy profiles_select_own on profiles for select
  using (id = auth.uid() or is_admin());
create policy profiles_insert_own on profiles for insert
  with check (id = auth.uid() and role <> 'admin');
create policy profiles_update_own on profiles for update
  using (id = auth.uid() or is_admin())
  with check (id = auth.uid() or is_admin());

-- zip_geo / app_config: readable by any authenticated user, writable only by admin.
create policy zip_geo_select_all on zip_geo for select using (true);
create policy zip_geo_admin_write on zip_geo for all using (is_admin()) with check (is_admin());
create policy app_config_select_all on app_config for select using (true);
create policy app_config_admin_write on app_config for all using (is_admin()) with check (is_admin());

-- jobs: customers see/manage their own jobs. Haulers only see a job directly once they've
-- bid on it or won it — open-jobs *browsing* for haulers goes through the list_open_jobs_for_hauler
-- RPC (SECURITY DEFINER) so the 50-mile radius filter can't be bypassed by querying the table raw.
create policy jobs_select on jobs for select using (
  customer_id = auth.uid()
  or is_admin()
  or hauler_bid_on_job(jobs.id)
);
create policy jobs_insert_own on jobs for insert with check (customer_id = auth.uid());
create policy jobs_update_own on jobs for update using (customer_id = auth.uid() or is_admin());

-- Uses the same RLS-bypassing helpers as bids_insert — a hauler deciding whether to bid on
-- an open job needs to see its photos before a bids row linking them to it exists, so a raw
-- EXISTS subquery on jobs (which would apply jobs_select's own restrictions) doesn't work here.
create policy job_photos_select on job_photos for select using (
  customer_owns_job(job_photos.job_id) or job_is_open_for_bid(job_photos.job_id) or is_admin()
);
create policy job_photos_insert on job_photos for insert with check (
  customer_owns_job(job_photos.job_id)
);

-- bids: hauler manages own bids; customer sees bids on their own jobs; admin sees all.
create policy bids_select on bids for select using (
  hauler_id = auth.uid()
  or is_admin()
  or customer_owns_job(bids.job_id)
);
-- Insert is restricted to hauler accounts, bidding on a currently-open, unexpired job —
-- the one-bid-per-hauler-per-job rule is enforced separately by the bids unique constraint.
create policy bids_insert on bids for insert with check (
  hauler_id = auth.uid()
  and exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'hauler')
  and job_is_open_for_bid(bids.job_id)
);

-- chats/messages/reviews: restricted to the two matched parties + admin.
create policy chats_select on chats for select using (
  customer_id = auth.uid() or hauler_id = auth.uid() or is_admin()
);
create policy messages_select on messages for select using (
  exists (select 1 from chats where chats.id = messages.chat_id
    and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid())) or is_admin()
);
create policy messages_insert on messages for insert with check (
  exists (select 1 from chats where chats.id = messages.chat_id
    and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid()))
);
create policy reviews_select on reviews for select using (
  exists (select 1 from chats where chats.id = reviews.chat_id
    and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid())) or is_admin()
);
-- A review can only be left by a matched participant, in their own role, once reviews are
-- unlocked (job confirmed complete) — mirrors the prototype's ReviewPanel gating.
create policy reviews_insert on reviews for insert with check (
  exists (
    select 1 from chats
    where chats.id = reviews.chat_id
      and chats.reviews_unlocked = true
      and (
        (reviews.reviewer_role = 'customer' and chats.customer_id = auth.uid())
        or (reviews.reviewer_role = 'hauler' and chats.hauler_id = auth.uid())
      )
  )
);
create policy reviews_update_own on reviews for update using (
  exists (
    select 1 from chats
    where chats.id = reviews.chat_id
      and (
        (reviews.reviewer_role = 'customer' and chats.customer_id = auth.uid())
        or (reviews.reviewer_role = 'hauler' and chats.hauler_id = auth.uid())
      )
  )
);

-- payments: participants can see their own job's payment status; only admin/service-role write.
create policy payments_select on payments for select using (
  is_admin() or exists (select 1 from jobs where jobs.id = payments.job_id and jobs.customer_id = auth.uid())
);

-- notifications: strictly the owning user (or admin).
create policy notifications_select on notifications for select using (
  user_id = auth.uid() or is_admin()
);
create policy notifications_update_own on notifications for update using (
  user_id = auth.uid()
) with check (user_id = auth.uid());

-- Realtime for instant in-app notifications + live chat/bid updates.
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table bids;

-- ─── Table grants ───────────────────────────────────────────────────────────────
-- RLS policies decide *which rows*; these grants decide which operations are even reachable
-- for a role in the first place (the platform's default is to expose nothing on new tables
-- until granted). service_role bypasses RLS entirely but still needs the base grant.
grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update on profiles to authenticated;
grant select on public_profiles to authenticated;
grant select, insert, update, delete on zip_geo to authenticated;
grant select, insert, update, delete on app_config to authenticated;
grant select, insert, update on jobs to authenticated;
grant select, insert on job_photos to authenticated;
grant select, insert on bids to authenticated;
grant select on chats to authenticated;
grant select, insert on messages to authenticated;
grant select, insert, update on reviews to authenticated;
grant select on payments to authenticated;
grant select, update on notifications to authenticated;

grant all on
  profiles, zip_geo, app_config, jobs, job_photos, bids, chats, messages, reviews, payments, notifications
  to service_role;
grant select on public_profiles to service_role;
