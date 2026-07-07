-- MyTrashBid — RPC functions for the marketplace flows that need atomic, server-recomputed
-- writes across multiple tables (never trust the client's number — accept-bid guide, section 1.3).
-- Straightforward single-table actions (post a job, submit a bid, send a message, submit a
-- review) are covered by direct inserts under the RLS policies from the previous migration —
-- no RPC wrapper needed for those.

-- ─── Single source of truth for the money split on any bid amount ─────────────
-- Mirrors the prototype's priceBreakdown(). Per the Scope of Work, v1 is deposit-only: the
-- deposit charged is always commission_rate * amount regardless of payment_mode. The 'full'
-- mode value is accepted and stored (the seam stays intact for a future phase) but does not
-- change what gets charged today.
create function price_breakdown(p_amount numeric, p_payment_mode text default 'deposit')
returns table (amount numeric, fee numeric, deposit_now numeric, balance_due numeric)
language sql stable as $$
  select
    p_amount,
    round(p_amount * app_config_numeric('commission_rate'), 2),
    round(p_amount * app_config_numeric('commission_rate'), 2),
    round(p_amount - round(p_amount * app_config_numeric('commission_rate'), 2), 2);
$$;

-- ─── Hauler job browsing with server-side radius enforcement ──────────────────
-- A hauler querying the jobs table directly only sees jobs they've already bid on (see the
-- jobs_select RLS policy) — this is the only path to *discover* open jobs, so the 50-mile
-- radius filter can never be bypassed by querying the table raw. ZIPs we can't geocode fail
-- open (distance shown as null) exactly like the prototype's zipDistanceMi() behavior.
create function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  created_at timestamptz, expires_at timestamptz, bid_count bigint, distance_mi numeric, photo_count bigint
)
language plpgsql security definer set search_path = public as $$
declare
  v_hauler profiles%rowtype;
  v_radius numeric;
begin
  select * into v_hauler from profiles where profiles.id = auth.uid();
  if v_hauler.id is null or v_hauler.role <> 'hauler' then
    raise exception 'Only hauler accounts can browse open jobs';
  end if;
  v_radius := app_config_numeric('max_radius_mi');

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode, j.created_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count
    from jobs j
    where j.status = 'open' and j.expires_at > now()
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;

-- ─── Accept a bid: recompute price server-side, book the job, open the chat ────
-- Called by the create-deposit-intent Edge Function on behalf of the signed-in customer
-- (their JWT is forwarded, so auth.uid() resolves correctly) before it talks to Stripe.
create function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_chat_id uuid;
begin
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
  values (v_bid.hauler_id, 'bidAccepted', 'You won a job!', v_job.title, p_job_id, v_chat_id);

  return query select v_chat_id, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_bid.amount;
end;
$$;

-- ─── Hauler confirms completion: unlocks reviews, finalizes commission ─────────
create function confirm_job_complete(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_notif_id uuid;
begin
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

-- ─── Renewals (14-day window, manual renewal only — matches the prototype exactly) ─
create function renew_job(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
begin
  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> auth.uid() then
    raise exception 'Only the job owner can renew this listing';
  end if;
  if v_job.status <> 'open' then
    raise exception 'Only open jobs can be renewed';
  end if;
  update jobs set created_at = now(), expires_at = now() + make_interval(days => app_config_numeric('live_window_days')::int)
    where id = p_job_id;
end;
$$;

create function renew_bid(p_bid_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_bid bids%rowtype;
  v_job jobs%rowtype;
begin
  select * into v_bid from bids where id = p_bid_id for update;
  if v_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_bid.hauler_id <> auth.uid() then
    raise exception 'Only the bidding hauler can renew this bid';
  end if;
  select * into v_job from jobs where id = v_bid.job_id;
  if v_job.status <> 'open' then
    raise exception 'This job is no longer open';
  end if;
  update bids set created_at = now(), expires_at = now() + make_interval(days => app_config_numeric('live_window_days')::int)
    where id = p_bid_id;
end;
$$;

-- ─── Scheduled 30-day-overdue completion reminder ──────────────────────────────
-- Notification-only; the prototype computes this client-side on every render (isExpired on
-- completeByMs). Server-side this has to be time-driven, so pg_cron runs it daily. The
-- overdue_notified flag stops it from re-firing every day for the same job.
create function send_overdue_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_notif_id uuid;
begin
  for r in
    select j.id as job_id, j.title, c.id as chat_id, c.hauler_id, c.customer_id
    from jobs j join chats c on c.job_id = j.id
    where j.status = 'booked' and not j.completed and j.complete_by < now() and not j.overdue_notified
  loop
    insert into notifications (user_id, event_type, title, body, job_id, chat_id)
      values (r.hauler_id, 'reminderOverdue', 'Please confirm job completion', r.title, r.job_id, r.chat_id)
      returning id into v_notif_id;
    perform dispatch_notification_email(v_notif_id);
    update jobs set overdue_notified = true where id = r.job_id;
  end loop;
end;
$$;

create extension if not exists pg_cron with schema extensions;
select cron.schedule('overdue-completion-reminders', '0 13 * * *', $$select send_overdue_reminders()$$);

-- ─── Grants: expose these as callable RPC endpoints via PostgREST ──────────────
grant execute on function price_breakdown(numeric, text) to anon, authenticated;
grant execute on function list_open_jobs_for_hauler() to authenticated;
grant execute on function accept_bid(uuid, uuid) to authenticated, service_role;
grant execute on function confirm_job_complete(uuid) to authenticated;
grant execute on function renew_job(uuid) to authenticated;
grant execute on function renew_bid(uuid) to authenticated;
