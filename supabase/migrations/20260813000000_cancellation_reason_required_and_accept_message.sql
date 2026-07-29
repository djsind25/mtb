-- MyTrashBid — require a reason on cancellation requests, and rework the full-mode accept_bid()
-- system message.
--
-- 1. request_cancellation(): a blank reason made it hard for admins reviewing cancellation
--    requests (see admin/CancellationRequestsTab.jsx) to tell what actually happened. The client
--    (RequestCancellationControl.jsx) now requires non-blank input before it will submit, but that's
--    only a UI nicety — this re-checks the same rule server-side so the RPC can't be called directly
--    with a blank reason.
-- 2. accept_bid(): the full-mode system message told customers to "propose a service date... in
--    chat" before the in-chat scheduling UI actually existed there — it only lived on the job card.
--    Now that ScheduleProposal is wired into ChatThread directly, the message is simplified to
--    describe what happens next (payment portal opens once a date is agreed) rather than telling
--    them where to go.

create or replace function request_cancellation(p_job_id uuid, p_reason text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_role text;
  v_other_party uuid;
  v_request_id uuid;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to request cancellation.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.status <> 'booked' then
    raise exception 'Only a booked job can have a cancellation requested';
  end if;
  if v_job.completed then
    raise exception 'This job is already completed and can no longer be cancelled';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null then
    raise exception 'No active chat for this job';
  end if;

  if v_chat.customer_id = auth.uid() then
    v_role := 'customer';
    v_other_party := v_chat.hauler_id;
  elsif v_chat.hauler_id = auth.uid() then
    v_role := 'hauler';
    v_other_party := v_chat.customer_id;
  else
    raise exception 'Only the customer or hauler on this job can request cancellation';
  end if;

  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is already pending for this job';
  end if;

  insert into cancellation_requests (job_id, chat_id, requested_by, requested_role, reason)
  values (p_job_id, v_chat.id, auth.uid(), v_role, p_reason)
  returning id into v_request_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('%s requested to cancel this job. Reason: "%s" — under review by MyTrashBid.',
    case when v_role = 'customer' then 'The customer' else 'The hauler' end, p_reason));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_other_party, 'cancellationRequested', 'Cancellation requested', v_job.title, p_job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return v_request_id;
end;
$$;

create or replace function accept_bid(p_job_id uuid, p_bid_id uuid)
returns table (chat_id uuid, deposit numeric, balance_due numeric, commission numeric, bid_amount numeric, payment_mode text)
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

  perform set_config('app.bypass_chat_guard', 'true', true);
  insert into chats (
    job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode,
    coordination_deadline
  )
  values (
    p_job_id, v_job.customer_id, v_bid.hauler_id, v_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_job.payment_mode,
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

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_job.customer_id, 'jobBooked', 'Your job is booked!', v_job.title, p_job_id, v_chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return query select v_chat_id, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_bid.amount, v_job.payment_mode;
end;
$$;
