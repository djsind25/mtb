-- MyTrashBid — account activation/deactivation for platform-abuse enforcement
-- Admin can deactivate a customer or hauler account (e.g. repeated off-platform-circumvention
-- flags, harassment, fraudulent bids). Deactivation is enforced in two layers: the client blocks
-- login for a deactivated account, and — since a client can't be trusted to police itself —
-- every write path a bad actor could still hit with a live session token is also locked down
-- server-side here.

alter table profiles
  add column active boolean not null default true,
  add column deactivated_at timestamptz;

create function is_active_user() returns boolean
  language sql stable security definer set search_path = public as $$
    select coalesce((select active from profiles where id = auth.uid()), false);
  $$;
grant execute on function is_active_user() to authenticated;

-- ─── RLS: block new writes from a deactivated account ──────────────────────────
drop policy jobs_insert_own on jobs;
create policy jobs_insert_own on jobs for insert with check (customer_id = auth.uid() and is_active_user());

drop policy bids_insert on bids;
create policy bids_insert on bids for insert with check (
  hauler_id = auth.uid()
  and is_active_user()
  and exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'hauler')
  and job_is_open_for_bid(bids.job_id)
);

drop policy messages_insert on messages;
create policy messages_insert on messages for insert with check (
  is_active_user()
  and exists (select 1 from chats where chats.id = messages.chat_id
    and (chats.customer_id = auth.uid() or chats.hauler_id = auth.uid()))
);

drop policy reviews_insert on reviews;
create policy reviews_insert on reviews for insert with check (
  is_active_user()
  and exists (
    select 1 from chats
    where chats.id = reviews.chat_id
      and chats.reviews_unlocked = true
      and (
        (reviews.reviewer_role = 'customer' and chats.customer_id = auth.uid())
        or (reviews.reviewer_role = 'hauler' and chats.hauler_id = auth.uid())
      )
  )
);

-- ─── RPCs: same enforcement for the multi-step marketplace actions ─────────────
create or replace function list_open_jobs_for_hauler()
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
  if not v_hauler.active then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
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

create or replace function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_bid bids%rowtype;
  v_pb record;
  v_chat_id uuid;
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

create or replace function renew_job(p_job_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

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

create or replace function renew_bid(p_bid_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_bid bids%rowtype;
  v_job jobs%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

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
