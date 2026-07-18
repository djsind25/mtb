-- MyTrashBid — Phase 3 of the payment rework: cancellation requests + admin refunds
--
-- Either party on a booked job can ask for it to be cancelled. That request never moves money by
-- itself — it just queues up for a full admin to review and decide the split, mirroring how every
-- other admin queue in this app works (flagged messages, hauler docs, completed jobs: surfaced as
-- a dashboard badge count, not pushed to admin as a notification).

create table cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references jobs(id),
  chat_id uuid not null references chats(id),
  requested_by uuid not null references profiles(id),
  requested_role text not null check (requested_role in ('customer', 'hauler')),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'resolved')),
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  refund_amount numeric(10,2),
  retained_amount numeric(10,2),
  created_at timestamptz not null default now()
);
create index cancellation_requests_job_id_idx on cancellation_requests (job_id);
-- One open request per job at a time — a second request while one's pending should surface as
-- "already requested," not create a race between two independent reviews of the same job.
create unique index cancellation_requests_job_id_pending_key on cancellation_requests (job_id) where status = 'pending';

alter table cancellation_requests enable row level security;
-- RLS policies only take effect once the role already has the base table privilege — this
-- project grants that per-table explicitly rather than blanket-granting on the whole schema
-- (see hauler_documents/chats/etc. in earlier migrations), so a new table needs its own grant
-- here too or every query against it 403s before RLS is even evaluated.
grant select on cancellation_requests to authenticated;

-- No insert/update policy at all, same shape as hauler_documents — every state change goes
-- through request_cancellation() / resolve_cancellation() below, keeping the state machine
-- airtight (nobody can hand-edit a request's status or resolved_* fields from the client).
create policy cancellation_requests_select on cancellation_requests for select
  using (
    is_admin()
    or exists (select 1 from jobs where jobs.id = cancellation_requests.job_id and jobs.customer_id = auth.uid())
    or exists (select 1 from chats where chats.id = cancellation_requests.chat_id and chats.hauler_id = auth.uid())
  );

alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check check (status = any(array['open', 'booked', 'pending_verification', 'cancelled']));

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled'
]));

-- Either party on the job's *current* chat can request cancellation. Notifies the other party
-- (not the requester, not admin — admin sees it via the dashboard badge) so they're not caught
-- off guard by the system message alone.
create function request_cancellation(p_job_id uuid, p_reason text default null)
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
  values (v_chat.id, 'system', format('%s requested to cancel this job.%s — under review by MyTrashBid.',
    case when v_role = 'customer' then 'The customer' else 'The hauler' end,
    case when p_reason is not null and p_reason <> '' then format(' Reason: "%s"', p_reason) else '' end));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_other_party, 'cancellationRequested', 'Cancellation requested', v_job.title, p_job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return v_request_id;
end;
$$;
revoke execute on function request_cancellation(uuid, text) from public;
grant execute on function request_cancellation(uuid, text) to authenticated;

-- While a cancellation is pending, the money/hauler-assignment flows that could race with it are
-- blocked — same reasoning as switching being blocked once hauler_done_at is set, just for a
-- different in-flight state.
create or replace function hauler_mark_done(p_job_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_before int;
  v_after int;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before marking work complete';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.hauler_id <> auth.uid() then
    raise exception 'Only the assigned hauler can mark this job complete';
  end if;
  if v_chat.hauler_done_at is not null then
    raise exception 'You have already marked this job complete';
  end if;

  select
    count(*) filter (where phase = 'before'),
    count(*) filter (where phase = 'after')
  into v_before, v_after
  from job_completion_photos where job_id = p_job_id;
  if v_before < 1 or v_after < 1 then
    raise exception 'Upload at least one before photo and one after photo before marking complete';
  end if;

  select * into v_job from jobs where id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set hauler_done_at = now() where id = v_chat.id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system',
    'Hauler marked the work complete and uploaded before/after photos. Please review and acknowledge completion.');

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
    values (v_chat.customer_id, 'jobMarkedDone', 'Your hauler marked the job complete', v_job.title, p_job_id, v_chat.id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;

create or replace function customer_acknowledge_completion(p_job_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before acknowledging completion';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.customer_id <> auth.uid() then
    raise exception 'Only the customer can acknowledge this job';
  end if;
  if v_chat.hauler_done_at is null then
    raise exception 'The hauler has not marked this job complete yet';
  end if;
  if v_chat.customer_ack_at is not null then
    raise exception 'You have already acknowledged this job';
  end if;

  select * into v_job from jobs where id = p_job_id;
  perform finalize_completion(v_chat, v_job, false);
end;
$$;

create or replace function preview_bid_switch(p_job_id uuid, p_new_bid_id uuid)
returns table (current_bid_amount numeric, new_bid_amount numeric, delta numeric, current_chat_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_new_bid bids%rowtype;
  v_chat chats%rowtype;
begin
  select * into v_job from jobs where id = p_job_id;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;
  if v_job.customer_id <> auth.uid() then
    raise exception 'Only the job owner can switch haulers';
  end if;
  if v_job.status <> 'booked' then
    raise exception 'Job is not booked';
  end if;
  if v_job.payment_mode <> 'full' then
    raise exception 'Switching haulers is only available for jobs paid in full';
  end if;
  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before switching haulers';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null then
    raise exception 'No active chat for this job';
  end if;
  if v_chat.hauler_done_at is not null then
    raise exception 'Work has already been marked complete on this job and the hauler can no longer be switched';
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

  return query select v_chat.bid_amount, v_new_bid.amount, (v_new_bid.amount - v_chat.bid_amount), v_chat.id;
end;
$$;

create or replace function finalize_bid_switch(
  p_job_id uuid, p_new_bid_id uuid, p_customer_id uuid,
  p_kind text default null, p_amount numeric default null, p_stripe_payment_intent_id text default null
)
returns table (chat_id uuid, delta numeric)
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_new_bid bids%rowtype;
  v_old_chat chats%rowtype;
  v_new_chat_id uuid;
  v_pb record;
  v_delta numeric;
  v_notif_id uuid;
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
  if v_job.payment_mode <> 'full' then
    raise exception 'Switching haulers is only available for jobs paid in full';
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
  select * into v_pb from price_breakdown(v_new_bid.amount, v_job.payment_mode);

  delete from job_completion_photos where job_id = p_job_id;

  perform set_config('app.bypass_chat_guard', 'true', true);
  update chats set superseded_at = now() where id = v_old_chat.id;

  insert into chats (job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode)
  values (p_job_id, v_job.customer_id, v_new_bid.hauler_id, v_new_bid.amount, v_pb.deposit_now, v_pb.balance_due, v_pb.fee, v_job.payment_mode)
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

  if p_kind is not null and p_amount is not null and p_amount <> 0 then
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

-- Read-only: every succeeded charge on the job, oldest first, with how much of *that specific*
-- PaymentIntent is still refundable (its amount minus whatever's already been refunded against
-- it). A job switched more than once can have more than one charge — the admin refund flow uses
-- this to split a refund across all of them instead of assuming there's only ever one.
create function job_refundable_charges(p_job_id uuid)
returns table (stripe_payment_intent_id text, charged numeric, refundable numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only admins can view refundable charges';
  end if;
  return query
    select
      c.stripe_payment_intent_id,
      c.amount as charged,
      c.amount - coalesce((
        select sum(r.amount) from payments r
        where r.kind = 'refund' and r.status = 'succeeded' and r.stripe_payment_intent_id = c.stripe_payment_intent_id
      ), 0) as refundable
    from payments c
    where c.job_id = p_job_id and c.kind = 'charge' and c.status = 'succeeded'
    order by c.created_at asc;
end;
$$;
revoke execute on function job_refundable_charges(uuid) from public;
grant execute on function job_refundable_charges(uuid) to authenticated;

-- Books a cancellation once every Stripe refund in p_refunds has actually succeeded — this
-- function never talks to Stripe, it only records what already happened (see
-- process-cancellation-refund). Granted to authenticated + is_full_admin(), not service-role —
-- unlike finalize_bid_switch's customer caller, a full admin is already a trusted actor
-- everywhere else in this app (they can edit any profile, approve any document, etc.), so this
-- matches the same trust level as admin_review_completion/review_hauler_document.
create function resolve_cancellation(p_request_id uuid, p_refund_amount numeric, p_retained_amount numeric, p_refunds jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req cancellation_requests%rowtype;
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_refund jsonb;
  v_notif_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve cancellation requests';
  end if;

  select * into v_req from cancellation_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Cancellation request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been resolved';
  end if;

  select * into v_job from jobs where id = v_req.job_id for update;
  select * into v_chat from chats where id = v_req.chat_id;

  for v_refund in select * from jsonb_array_elements(p_refunds)
  loop
    insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
    values (v_req.job_id, v_req.chat_id, (v_refund->>'amount')::numeric, 'succeeded', 'refund', v_refund->>'stripe_payment_intent_id');
  end loop;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set status = 'cancelled' where id = v_req.job_id;

  update cancellation_requests set
    status = 'resolved', resolved_by = auth.uid(), resolved_at = now(),
    refund_amount = p_refund_amount, retained_amount = p_retained_amount
  where id = p_request_id;

  insert into messages (chat_id, sender_role, text)
  values (v_req.chat_id, 'system', format('This job was cancelled by MyTrashBid. $%s was refunded to the customer.%s',
    p_refund_amount, case when p_retained_amount > 0 then format(' $%s was retained.', p_retained_amount) else '' end));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.customer_id, 'jobCancelled', 'Job cancelled', v_job.title, v_req.job_id, v_req.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.hauler_id, 'jobCancelled', 'Job cancelled', v_job.title, v_req.job_id, v_req.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;
revoke execute on function resolve_cancellation(uuid, numeric, numeric, jsonb) from public;
grant execute on function resolve_cancellation(uuid, numeric, numeric, jsonb) to authenticated;
