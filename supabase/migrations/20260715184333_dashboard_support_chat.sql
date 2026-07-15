-- ─── Support chat ──────────────────────────────────────────────────────────────
-- Independent of the job-scoped chats/messages (those are shaped around bid_amount/deposit/
-- commission — not a fit for "message support"). Any admin, not just an assigned one, can see
-- and answer every open ticket, matching the existing is_admin() pattern used everywhere else.
create table support_chats (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id),
  assigned_admin_id uuid references profiles(id),  -- set to whichever admin first replies; display-only, not access-restricting
  status            text not null default 'open' check (status in ('open', 'closed')),
  created_at        timestamptz not null default now()
);

create table support_messages (
  id               uuid primary key default gen_random_uuid(),
  support_chat_id  uuid not null references support_chats(id) on delete cascade,
  sender_id        uuid not null references profiles(id),
  sender_role      text not null check (sender_role in ('customer', 'hauler', 'admin')),
  text             text not null,
  created_at       timestamptz not null default now()
);

alter table support_chats enable row level security;
alter table support_messages enable row level security;

create policy support_chats_select on support_chats for select using (
  user_id = auth.uid() or is_admin()
);
create policy support_chats_insert on support_chats for insert with check (
  user_id = auth.uid() or is_admin()
);
create policy support_chats_update on support_chats for update using (
  user_id = auth.uid() or is_admin()
);

create policy support_messages_select on support_messages for select using (
  exists (select 1 from support_chats sc where sc.id = support_chat_id and (sc.user_id = auth.uid() or is_admin()))
);
create policy support_messages_insert on support_messages for insert with check (
  exists (select 1 from support_chats sc where sc.id = support_chat_id and (sc.user_id = auth.uid() or is_admin()))
);

grant select, insert, update on support_chats to authenticated;
grant select, insert on support_messages to authenticated;

create function assign_support_chat_on_admin_reply() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.sender_role = 'admin' then
    update support_chats set assigned_admin_id = new.sender_id
      where id = new.support_chat_id and assigned_admin_id is null;
  end if;
  return new;
end;
$$;

create trigger support_messages_assign after insert on support_messages
  for each row execute function assign_support_chat_on_admin_reply();

alter publication supabase_realtime add table support_chats;
alter publication supabase_realtime add table support_messages;

-- ─── Dashboard support ─────────────────────────────────────────────────────────

-- Haulers currently can't read their own deposit/payment history — only the job's customer (or
-- admin) could. Extend to also cover the hauler side of the chat the payment belongs to.
drop policy payments_select on payments;
create policy payments_select on payments for select using (
  is_admin()
  or exists (select 1 from jobs where jobs.id = payments.job_id and jobs.customer_id = auth.uid())
  or exists (select 1 from chats where chats.id = payments.chat_id and chats.hauler_id = auth.uid())
);

-- Unread-message tracking for the new Messages tab: null = never read = unread if any message
-- exists; otherwise unread if the other party's latest message is newer than my last read time.
alter table chats
  add column customer_last_read_at timestamptz,
  add column hauler_last_read_at timestamptz;

-- profiles_update_own (init migration) has no WITH CHECK, so any authenticated user can currently
-- update *any* column on their own row — role, verified, rating, rating_count, active (i.e.
-- reactivating a deactivated account), or the verification-token columns. Self-service profile
-- editing is now a real feature, so this closes that gap: self-deactivation (active true→false)
-- stays allowed, everything else protected stays blocked for non-admins.
--
-- Only restricts genuine self-edits (new.id = the calling user). update_hauler_rating() (reviews
-- trigger) updates a *different* user's row (the hauler being reviewed) as a SECURITY DEFINER
-- function — SECURITY DEFINER changes privilege checks, not whether row-level triggers fire, so
-- without the new.id = auth.uid() check here, a customer leaving a review would trip this guard
-- via that legitimate system update to the hauler's rating/rating_count. verify_email() *does*
-- target the caller's own row (they're auto-logged-in by the time they click the link), so it
-- explicitly opts out via a transaction-local flag rather than relying on the id check.
create function guard_profile_self_update() returns trigger
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
    or (new.active and not old.active)
  then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_self_update before update on profiles
  for each row execute function guard_profile_self_update();

-- The Account tab's "email" field goes through supabase.auth.updateUser({email}) (Supabase's own
-- re-confirmation flow), not a raw profiles.email edit — that column is just a mirror, so keep it
-- synced once the change actually lands on auth.users.
create function sync_profile_email() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger auth_users_sync_email after update of email on auth.users
  for each row execute function sync_profile_email();

-- Patches verify_email() (previous migration) to opt out of the new self-update guard above —
-- it legitimately sets email_verified_at/email_verify_token on what is typically the caller's
-- own (already auto-logged-in) row. Logic otherwise unchanged from the original.
create or replace function verify_email(p_token text) returns boolean
  language plpgsql security definer set search_path = public as $$
declare
  v_profile_id uuid;
begin
  select id into v_profile_id from profiles
    where email_verify_token = p_token and email_verified_at is null;
  if v_profile_id is null then
    return false;
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  update profiles set email_verified_at = now(), email_verify_token = null where id = v_profile_id;

  update jobs set
    status = 'open',
    expires_at = now() + make_interval(days => (case when service_type = 'rental'
      then app_config_numeric('rental_live_window_days')::int
      else app_config_numeric('live_window_days')::int
    end))
  where customer_id = v_profile_id and status = 'pending_verification';

  return true;
end;
$$;

-- chats never had an UPDATE grant or policy at all — fine until now, since the only server-side
-- writer (confirm_job_complete) is SECURITY DEFINER and bypasses RLS. The new Messages tab needs
-- customers/haulers to set their own *_last_read_at, which is a genuine client-side self-update,
-- so both are needed now. Column-level restriction (only the two read-timestamp columns, never
-- bid_amount/deposit/commission_status/etc.) is enforced the same way as the profiles guard above
-- — confirm_job_complete legitimately updates commission_status/reviews_unlocked on a row where
-- the caller (the hauler) *is* one of the row's own parties, so it opts out via the same
-- transaction-local-flag pattern used for verify_email(), since an id/auth.uid() mismatch check
-- doesn't apply here (there's no single "owner id" column on chats).
grant update on chats to authenticated;

create policy chats_update_own on chats for update using (
  customer_id = auth.uid() or hauler_id = auth.uid() or is_admin()
);

create function guard_chat_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_admin() or coalesce(current_setting('app.bypass_chat_guard', true), '') = 'true' then
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

create trigger chats_guard_self_update before update on chats
  for each row execute function guard_chat_self_update();

create or replace function confirm_job_complete(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;

  select * into v_chat from chats where job_id = p_job_id;
  if v_chat.id is null or v_chat.hauler_id <> auth.uid() then
    raise exception 'Only the assigned hauler can confirm this job complete';
  end if;
  if v_job.completed then
    raise exception 'Job is already marked complete';
  end if;

  update jobs set completed = true, completed_at = now() where id = p_job_id;
  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set commission_status = 'earned', reviews_unlocked = true where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system',
    format('Job confirmed complete. Make sure the $%s balance was settled directly with your hauler. Both sides can now leave a review.', v_chat.balance_due));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (v_chat.customer_id, 'jobCompleted', 'Job completed — leave a review', v_job.title, p_job_id, v_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (v_chat.hauler_id, 'jobCompleted', 'Job completed — leave a review', v_job.title, p_job_id, v_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
end;
$$;
