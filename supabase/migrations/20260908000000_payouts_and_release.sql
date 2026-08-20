-- Stripe Connect Express payment rework — Phase 3: completion + release.
--
-- Once a job is confirmed complete (customer acknowledges, or the auto-release window elapses
-- with no response), the hauler's share is transferred out of the platform's Stripe balance for
-- real. Both paths already funnel through finalize_completion() (customer_acknowledge_completion
-- for the manual path, auto_acknowledge_stale_completions() for the timeout path), so the payout
-- row and release dispatch are added there once, not duplicated across both callers.
--
-- The auto-release window changes from 7 days to 48 hours to match the approved plan, and its
-- cron polling tightens from once daily to every 15 minutes — a 48-hour window needs much finer
-- granularity than a 7-day one, or a hauler could wait up to a day past the real deadline.

-- ─── 1. payouts — one row per real transfer attempt. status is its own domain, separate from
--    payments.status (separate domain fields per concept: jobs status, payments status, payouts
--    status — none of them one shared mega-enum). ───────────────────────────────────────────────

create table if not exists payouts (
    id uuid default gen_random_uuid() not null primary key,
    job_id uuid not null references jobs(id),
    chat_id uuid not null references chats(id),
    payment_id uuid references payments(id),
    hauler_id uuid not null references profiles(id),
    stripe_connect_account_id text not null,
    amount numeric(10,2) not null,
    status text default 'pending' not null,
    stripe_transfer_id text,
    stripe_reversal_id text,
    reversed_amount numeric(10,2),
    released_at timestamptz,
    reversed_at timestamptz,
    created_by uuid references profiles(id),
    created_at timestamptz default now() not null,
    constraint payouts_amount_check check (amount > 0),
    constraint payouts_status_check check (status = any (array['pending', 'paid', 'reversed', 'failed']))
);

alter table payouts owner to postgres;
alter table payouts enable row level security;

create unique index payouts_stripe_transfer_id_idx on payouts (stripe_transfer_id) where stripe_transfer_id is not null;
create index payouts_job_id_idx on payouts (job_id);
create index payouts_chat_id_idx on payouts (chat_id);

-- Hauler sees their own payouts; admins see all. No INSERT/UPDATE policy — every write goes
-- through SECURITY DEFINER functions, same trust model as payments/cancellation_requests.
create policy payouts_select on payouts for select
  using (hauler_id = auth.uid() or is_admin());

grant select on table payouts to authenticated;
grant all on table payouts to service_role;

-- ─── 2. dispatch_payout_release() — pg_net fire-and-forget dispatch to the process-payout-release
--    Edge Function, structurally identical to dispatch_notification_email(). ────────────────────

create or replace function dispatch_payout_release(p_payout_id uuid) returns void
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
    url := v_base_url || '/process-payout-release',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object('payoutId', p_payout_id)
  );
exception when others then
  raise warning 'dispatch_payout_release failed for %: %', p_payout_id, sqlerrm;
end;
$$;

-- ─── 3. finalize_completion() — inserts the payouts row and fires the release dispatch, right
--    after the existing bookkeeping. Both existing callers (customer_acknowledge_completion,
--    auto_acknowledge_stale_completions) get this for free with no changes of their own. ─────────

create or replace function finalize_completion(p_chat chats, p_job jobs, p_auto boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_notif_id uuid;
  v_payout_id uuid;
  v_payment_id uuid;
  v_connect_account_id text;
begin
  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set
    customer_ack_at = now(), commission_status = 'earned', reviews_unlocked = true,
    captured_at = case when p_job.payment_mode = 'full' and authorized_at is not null and captured_at is null then now() else captured_at end
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

  -- Release the hauler's share for real. The funding charge is whichever succeeded 'charge' row
  -- is most recent on this job (covers the switch-hauler case, where an earlier charge may have
  -- been partially refunded and a later one covers the delta).
  select id into v_payment_id from payments
  where job_id = p_job.id and kind = 'charge' and status = 'succeeded'
  order by created_at desc limit 1;

  select stripe_connect_account_id into v_connect_account_id from profiles where id = p_chat.hauler_id;

  insert into payouts (job_id, chat_id, payment_id, hauler_id, stripe_connect_account_id, amount, status)
  values (p_job.id, p_chat.id, v_payment_id, p_chat.hauler_id, v_connect_account_id, p_chat.bid_amount - p_chat.commission, 'pending')
  returning id into v_payout_id;

  perform dispatch_payout_release(v_payout_id);
end;
$$;

-- ─── 4. Auto-release window: 7 days -> 48 hours, matching the approved plan. One consumer of this
--    config key (auto_acknowledge_stale_completions), so it's renamed rather than left alongside
--    a second, redundant key. ───────────────────────────────────────────────────────────────────

delete from app_config where key = 'ack_auto_window_days';
insert into app_config (key, value) values ('ack_auto_window_hours', '48')
  on conflict (key) do update set value = excluded.value;

create or replace function auto_acknowledge_stale_completions() returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_chat chats%rowtype;
  v_job jobs%rowtype;
  v_window int;
  r record;
begin
  v_window := app_config_numeric('ack_auto_window_hours')::int;
  for r in
    select c.id from chats c
    join jobs j on j.id = c.job_id
    where c.hauler_done_at is not null
      and c.customer_ack_at is null
      and c.hauler_done_at < now() - make_interval(hours => v_window)
      and j.status = 'booked'
      -- A pending cancellation already blocks the manual ack path (see
      -- customer_acknowledge_completion) — same guard here so the auto-release sweep can't race
      -- past an open cancellation request either.
      and not exists (select 1 from cancellation_requests cr where cr.job_id = j.id and cr.status = 'pending')
  loop
    select * into v_chat from chats where id = r.id;
    select * into v_job from jobs where id = v_chat.job_id;
    perform finalize_completion(v_chat, v_job, true);
  end loop;
end;
$$;

-- Re-schedule from daily to every 15 minutes — a 48h window needs much finer polling than the
-- old 7-day one did, or a hauler could wait up to a day past the real deadline for release.
select cron.unschedule('auto-acknowledge-completions');
select cron.schedule('auto-acknowledge-completions', '*/15 * * * *', $cron$select auto_acknowledge_stale_completions()$cron$);

-- ─── 5. finalize_bid_switch() — the defensive "already paid out" check flagged as deferred in the
--    Phase 2 migration, now that payouts exists. ───────────────────────────────────────────────

create or replace function finalize_bid_switch(
  p_job_id uuid, p_new_bid_id uuid, p_customer_id uuid,
  p_kind text default null, p_amount numeric default null, p_stripe_payment_intent_id text default null,
  p_refunds jsonb default null
) returns table(chat_id uuid, delta numeric)
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_new_bid bids%rowtype;
  v_old_chat chats%rowtype;
  v_new_chat_id uuid;
  v_pb record;
  v_rate numeric;
  v_service_fee numeric;
  v_delta numeric;
  v_notif_id uuid;
  v_refund jsonb;
begin
  if p_kind is not null and p_kind not in ('charge', 'refund') then
    raise exception 'Invalid payment kind';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> p_customer_id then
    raise exception 'Only the job owner can switch haulers';
  end if;
  if v_job.status <> 'booked' then
    raise exception 'Job is not booked';
  end if;
  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before switching haulers';
  end if;

  select * into v_old_chat from chats where job_id = p_job_id and superseded_at is null for update;
  if v_old_chat.id is null then
    raise exception 'No active chat for this job';
  end if;
  if v_old_chat.hauler_done_at is not null then
    raise exception 'Work has already been marked complete on this job and the hauler can no longer be switched';
  end if;
  -- Money that already left the platform balance can't be undone by a plain refund — this
  -- shouldn't normally be reachable (hauler_done_at above already blocks switching once work is
  -- marked complete, and a payout only ever gets created after that point), but it's a real,
  -- cheap defensive check now that payouts exists.
  if exists (select 1 from payouts where chat_id = v_old_chat.id and status = 'paid') then
    raise exception 'This hauler has already been paid out for this job and can no longer be switched';
  end if;

  select * into v_new_bid from bids where id = p_new_bid_id and job_id = p_job_id;
  if v_new_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_new_bid.id = v_job.accepted_bid_id then
    raise exception 'This hauler is already assigned to the job';
  end if;
  if v_new_bid.expires_at <= now() then
    raise exception 'This bid has expired and can no longer be selected';
  end if;

  v_delta := v_new_bid.amount - v_old_chat.bid_amount;
  select membership_commission_rate(p.membership_tier) into v_rate from profiles p where p.id = v_new_bid.hauler_id;
  select * into v_pb from price_breakdown(v_new_bid.amount, 'full', v_rate);
  select round(v_new_bid.amount * (select service_fee_rate from platform_fee_config where id = true), 2) into v_service_fee;

  delete from job_completion_photos where job_id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set superseded_at = now() where id = v_old_chat.id;

  insert into chats (job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, commission_rate, payment_mode, service_fee, transfer_group)
  values (p_job_id, v_job.customer_id, v_new_bid.hauler_id, v_new_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_rate, v_job.payment_mode, v_service_fee, v_old_chat.transfer_group)
  returning id into v_new_chat_id;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set accepted_bid_id = p_new_bid_id where id = p_job_id;

  insert into messages (chat_id, sender_role, text)
  values (v_old_chat.id, 'system', 'The customer switched to another hauler for this job.');

  insert into messages (chat_id, sender_role, text)
  values (v_new_chat_id, 'system',
    case when v_delta > 0 then format('You''ve been assigned this job after the customer switched haulers! Bid: $%s (an additional $%s was charged to cover the difference).', v_new_bid.amount, v_delta)
      when v_delta < 0 then format('You''ve been assigned this job after the customer switched haulers! Bid: $%s ($%s of the difference was refunded to the customer).', v_new_bid.amount, abs(v_delta))
      else format('You''ve been assigned this job after the customer switched haulers! Bid: $%s (no change to the amount already held).', v_new_bid.amount)
    end);

  if p_refunds is not null then
    for v_refund in select * from jsonb_array_elements(p_refunds)
    loop
      insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
      values (p_job_id, v_new_chat_id, (v_refund->>'amount')::numeric, 'succeeded', 'refund', v_refund->>'stripe_payment_intent_id');
    end loop;
  elsif p_kind is not null and p_amount is not null and p_amount <> 0 then
    insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
    values (p_job_id, v_new_chat_id, abs(p_amount), 'succeeded', p_kind, p_stripe_payment_intent_id);
  end if;

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_old_chat.hauler_id, 'bidSwitchedOut', 'Customer switched to another hauler', v_job.title, p_job_id, v_old_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_new_bid.hauler_id, 'bidAccepted', 'You won a job!', v_job.title, p_job_id, v_new_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return query select v_new_chat_id, v_delta;
end;
$$;

-- ─── 6. check_account_deletion_blockers() — a hauler with an unreleased payout can't be deleted/
--    anonymized out from under it. ────────────────────────────────────────────────────────────

create or replace function check_account_deletion_blockers(p_target_user_id uuid default null)
returns table (blocker_type text, message text, link_kind text, link_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid;
begin
  if p_target_user_id is not null and p_target_user_id <> auth.uid() and not is_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Not authorized to check this account.';
  end if;
  v_uid := coalesce(p_target_user_id, auth.uid());
  if v_uid is null then
    raise exception 'No account specified.';
  end if;

  return query
  select 'active_job'::text,
    format('Your job "%s" is still open or in progress.', j.title), 'job'::text, j.id
  from jobs j
  where j.customer_id = v_uid and (j.status = 'open' or (j.status = 'booked' and not j.completed))

  union all
  select 'accepted_bid_incomplete'::text,
    format('You''re the assigned hauler on "%s", which hasn''t been marked complete yet.', j.title),
    'job'::text, j.id
  from jobs j join bids b on b.id = j.accepted_bid_id
  where b.hauler_id = v_uid and j.status = 'booked' and not j.completed

  union all
  select 'pending_payment'::text,
    format('Job "%s" has a balance that hasn''t finished settling yet.', j.title), 'chat'::text, c.id
  from chats c join jobs j on j.id = c.job_id
  where c.superseded_at is null and (c.customer_id = v_uid or c.hauler_id = v_uid)
    and (c.commission_status = 'held'
      or (c.payment_mode = 'full' and c.authorized_at is not null and c.captured_at is null))

  union all
  select 'pending_payment'::text,
    format('A refund for "%s" is still processing.', j.title), 'job'::text, j.id
  from cancellation_requests cr join jobs j on j.id = cr.job_id
  where cr.status = 'resolved'
    and (j.customer_id = v_uid or exists (select 1 from chats c2 where c2.id = cr.chat_id and c2.hauler_id = v_uid))
    and exists (select 1 from payments p where p.job_id = cr.job_id and p.kind = 'refund' and p.status <> 'succeeded')

  union all
  -- A hauler's payout hasn't actually moved yet — deleting/anonymizing the account out from under
  -- a pending transfer would strand it with no valid connected account.
  select 'pending_payment'::text,
    format('Job "%s" has a payout to you that hasn''t completed yet.', j.title), 'job'::text, j.id
  from payouts po join jobs j on j.id = po.job_id
  where po.hauler_id = v_uid and po.status = 'pending'

  union all
  select 'open_dispute'::text,
    format('A cancellation request on "%s" is still under review.', j.title), 'job'::text, j.id
  from cancellation_requests cr join jobs j on j.id = cr.job_id
  where cr.status = 'pending'
    and (j.customer_id = v_uid or exists (select 1 from chats c3 where c3.id = cr.chat_id and c3.hauler_id = v_uid))

  union all
  select 'open_dispute'::text, 'A support conversation on one of your jobs is still open.'::text,
    'chat'::text, c4.id
  from chats c4
  where c4.superseded_at is null and (c4.customer_id = v_uid or c4.hauler_id = v_uid)
    and (c4.support_status in ('requested', 'active')
      or exists (select 1 from support_requests sr where sr.chat_id = c4.id and sr.status = 'pending'))

  union all
  select 'open_dispute'::text, 'Your account has an open review flag that needs to be resolved first.'::text,
    'flag'::text, f.id
  from admin_user_flags f
  where f.user_id = v_uid and f.resolved_at is null;
end;
$$;
revoke execute on function check_account_deletion_blockers(uuid) from public;
grant execute on function check_account_deletion_blockers(uuid) to authenticated;
