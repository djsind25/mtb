-- MyTrashBid — timeline expectation on job posts ("How soon do you need this done?")
--
-- Nullable so existing jobs from before this migration keep working untouched — the app treats
-- a null timeline as "no badge shown" on job cards (see web/src/theme.js's timelineMeta()).
alter table jobs
  add column timeline text check (timeline in ('asap', 'this_week', 'next_2_weeks', 'this_month', 'flexible'));

-- jobs never had a self-update guard (unlike profiles/chats) because until now nothing let a
-- customer directly update their own job row from the client — renew_job/accept_bid are all
-- server-side RPCs. Editable timeline changes that, so this closes the same kind of gap: only
-- `timeline` may be client-edited, and only before a bid is accepted (once booked, the price was
-- already set around that urgency — a later change becomes a chat conversation instead).
--
-- Bypasses: is_admin() for admin edits, auth.role() = 'service_role' for the create-deposit-intent
-- edge function's booking-rollback path (which updates several other columns directly via the
-- admin client), and the app.bypass_job_guard flag for the trusted RPCs below that legitimately
-- update other columns as the job's own owner.
create function guard_job_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_admin() or auth.role() = 'service_role'
    or coalesce(current_setting('app.bypass_job_guard', true), '') = 'true'
  then
    return new;
  end if;

  if old.status = 'booked' and new.timeline is distinct from old.timeline then
    raise exception 'Timeline can only be changed before a bid is accepted.';
  end if;

  if to_jsonb(new) - 'timeline' <> to_jsonb(old) - 'timeline' then
    raise exception 'Not permitted to change this field.';
  end if;

  return new;
end;
$$;

create trigger jobs_guard_self_update before update on jobs
  for each row execute function guard_job_self_update();

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
  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set created_at = now(), expires_at = now() + make_interval(days => app_config_numeric('live_window_days')::int)
    where id = p_job_id;
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

  perform set_config('app.bypass_job_guard', 'true', true);
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

  perform set_config('app.bypass_job_guard', 'true', true);
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

create or replace function send_overdue_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_notif_id uuid;
begin
  perform set_config('app.bypass_job_guard', 'true', true);
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

-- Postgres won't let CREATE OR REPLACE change a function's output columns, so adding the
-- timeline column to what haulers see needs a real drop-and-recreate (same reason the rental
-- migration had to do this).
drop function if exists list_open_jobs_for_hauler();

create function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date,
  timeline text,
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
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode,
      j.service_type, j.dumpster_type, j.rental_start_date, j.rental_end_date,
      j.timeline,
      j.created_at, j.expires_at,
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

grant execute on function list_open_jobs_for_hauler() to authenticated;
