-- Stripe Connect Express payment rework — Phase 4: disputes.
--
-- Lets a customer report a problem once the hauler has marked a job done, instead of just
-- silently approving or letting the 48h auto-release fire. Modeled directly on the existing
-- cancellation_requests claim/resolve pattern (claim_cancellation_for_refund /
-- release_cancellation_claim / resolve_cancellation) — same atomic claim-lock shape, same
-- is_full_admin()+require_aal2() gate, same "RPC only ever books pre-executed Stripe results"
-- split between SQL and the Edge Function.

-- ─── 1. disputes ────────────────────────────────────────────────────────────────────────────────

create table if not exists disputes (
    id uuid default gen_random_uuid() not null primary key,
    job_id uuid not null references jobs(id),
    chat_id uuid not null references chats(id),
    opened_by uuid not null references profiles(id),
    reason text not null,
    status text default 'open' not null,
    resolution_in_progress boolean default false not null,
    claimed_by uuid references profiles(id),
    resolved_by uuid references profiles(id),
    resolved_at timestamptz,
    refund_amount numeric(10,2),
    provider_payout_amount numeric(10,2),
    resolution_note text,
    created_at timestamptz default now() not null,
    constraint disputes_status_check check (status = any (array['open', 'reviewing', 'resolved_customer', 'resolved_provider']))
);

alter table disputes owner to postgres;
alter table disputes enable row level security;

create index disputes_job_id_idx on disputes (job_id);

-- The customer who opened it, the job's hauler, and admins can all read. No INSERT/UPDATE policy
-- — every write goes through SECURITY DEFINER functions below.
create policy disputes_select on disputes for select
  using (
    opened_by = auth.uid()
    or exists (select 1 from chats c where c.id = chat_id and c.hauler_id = auth.uid())
    or is_admin()
  );

grant select on table disputes to authenticated;
grant all on table disputes to service_role;

-- ─── 2. notifications_event_type_check — widen for the two new dispute events. ────────────────────

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered',
  'bidRevisionProposed', 'bidRevisionResolved',
  'scheduleProposed', 'scheduleConfirmed', 'coordinationNudge', 'paymentAuthorized',
  'supportRequested', 'adminJoined', 'supportResolved', 'chatLocked', 'chatUnlocked',
  'disputeOpened', 'disputeResolved'
]));

-- ─── 3. open_dispute() — the customer's "report a problem" action. Only reachable once the
--    hauler has claimed the job done (hauler_done_at set) — before that, request_cancellation is
--    the right tool (the job hasn't been worked yet). No upper time bound: a customer can still
--    open one after the job shows completed, e.g. discovering damage a few days later. ───────────

create or replace function open_dispute(p_job_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_dispute_id uuid;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to report a problem.';
  end if;

  select * into v_job from jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'Job not found';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.customer_id <> auth.uid() then
    raise exception 'Only the customer on this job can report a problem';
  end if;
  if v_chat.hauler_done_at is null then
    raise exception 'The hauler hasn''t marked this job complete yet — use "Request cancellation" instead.';
  end if;
  if exists (select 1 from disputes where job_id = p_job_id and status in ('open', 'reviewing')) then
    raise exception 'A dispute is already open for this job';
  end if;

  insert into disputes (job_id, chat_id, opened_by, reason)
  values (p_job_id, v_chat.id, auth.uid(), p_reason)
  returning id into v_dispute_id;

  insert into messages (chat_id, sender_role, text)
  values (v_chat.id, 'system', format('The customer reported a problem with this job. Reason: "%s" — under review by MyTrashBid.', p_reason));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.hauler_id, 'disputeOpened', 'A problem was reported on your job', v_job.title, p_job_id, v_chat.id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return v_dispute_id;
end;
$$;
revoke all on function open_dispute(uuid, text) from public;
grant all on function open_dispute(uuid, text) to authenticated;

-- ─── 4. Block completion/release while a dispute is open — same guard shape as the existing
--    cancellation_requests check on these same two functions. ────────────────────────────────────

create or replace function customer_acknowledge_completion(p_job_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
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

  if exists (select 1 from cancellation_requests where job_id = p_job_id and status = 'pending') then
    raise exception 'A cancellation request is pending for this job — resolve it before acknowledging completion';
  end if;
  if exists (select 1 from disputes where job_id = p_job_id and status in ('open', 'reviewing')) then
    raise exception 'A dispute is open for this job — it needs to be resolved first';
  end if;

  select * into v_job from jobs where id = p_job_id;
  if v_job.status <> 'booked' then
    raise exception 'This job is no longer booked';
  end if;
  perform finalize_completion(v_chat, v_job, false);
end;
$$;

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
      and not exists (select 1 from cancellation_requests cr where cr.job_id = j.id and cr.status = 'pending')
      and not exists (select 1 from disputes d where d.job_id = j.id and d.status in ('open', 'reviewing'))
  loop
    select * into v_chat from chats where id = r.id;
    select * into v_job from jobs where id = v_chat.job_id;
    perform finalize_completion(v_chat, v_job, true);
  end loop;
end;
$$;

-- ─── 5. Claim/release, mirroring claim_cancellation_for_refund / release_cancellation_claim
--    exactly. ─────────────────────────────────────────────────────────────────────────────────

create or replace function claim_dispute_for_resolution(p_dispute_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve disputes';
  end if;
  perform require_aal2();
  update disputes set resolution_in_progress = true, status = 'reviewing', claimed_by = auth.uid()
    where id = p_dispute_id and status = 'open' and resolution_in_progress = false;
  if not found then
    raise exception 'This dispute is already being processed or has been resolved.';
  end if;
end;
$$;

create or replace function release_dispute_claim(p_dispute_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve disputes';
  end if;
  update disputes set resolution_in_progress = false, status = 'open', claimed_by = null
    where id = p_dispute_id and status = 'reviewing';
end;
$$;

-- ─── 6. job_reversible_payouts() — admin-only read, structurally identical to
--    job_refundable_charges but over payouts.status='paid' rows instead of payments. ─────────────

create or replace function job_reversible_payouts(p_job_id uuid)
returns table (payout_id uuid, stripe_transfer_id text, paid numeric, reversible numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only admins can view reversible payouts';
  end if;
  return query
    select po.id, po.stripe_transfer_id, po.amount, po.amount - coalesce(po.reversed_amount, 0)
    from payouts po
    where po.job_id = p_job_id and po.status = 'paid'
    order by po.created_at asc;
end;
$$;
revoke all on function job_reversible_payouts(uuid) from public;
grant all on function job_reversible_payouts(uuid) to authenticated;

-- ─── 7. resolve_dispute() — books whatever the Edge Function already did against real Stripe:
--    refund rows (p_refunds, same shape as resolve_cancellation), reversal amounts against
--    existing paid payouts (p_reversals), and/or a brand new payout if the job's completion was
--    blocked by this dispute before any payout ever existed (dispatches it via the same
--    process-payout-release path finalize_completion uses). ───────────────────────────────────

create or replace function resolve_dispute(
  p_dispute_id uuid,
  p_status text,
  p_refund_amount numeric,
  p_provider_payout_amount numeric,
  p_refunds jsonb,
  p_reversals jsonb,
  p_note text
) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_dispute disputes%rowtype;
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_refund jsonb;
  v_reversal jsonb;
  v_new_payout_id uuid;
  v_notif_id uuid;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can resolve disputes';
  end if;
  if p_status not in ('resolved_customer', 'resolved_provider') then
    raise exception 'Invalid resolution status';
  end if;

  select * into v_dispute from disputes where id = p_dispute_id for update;
  if v_dispute.id is null then
    raise exception 'Dispute not found';
  end if;
  if v_dispute.status <> 'reviewing' then
    raise exception 'This dispute has already been resolved';
  end if;
  if not job_in_admin_territory(v_dispute.job_id) then
    raise exception 'This job is outside your assigned territory.';
  end if;

  select * into v_job from jobs where id = v_dispute.job_id for update;
  select * into v_chat from chats where id = v_dispute.chat_id;

  for v_refund in select * from jsonb_array_elements(coalesce(p_refunds, '[]'::jsonb))
  loop
    insert into payments (job_id, chat_id, amount, status, kind, stripe_payment_intent_id)
    values (v_dispute.job_id, v_dispute.chat_id, (v_refund->>'amount')::numeric, 'succeeded', 'refund', v_refund->>'stripe_payment_intent_id');
  end loop;

  for v_reversal in select * from jsonb_array_elements(coalesce(p_reversals, '[]'::jsonb))
  loop
    update payouts set
      reversed_amount = coalesce(reversed_amount, 0) + (v_reversal->>'amount')::numeric,
      reversed_at = now(),
      stripe_reversal_id = v_reversal->>'stripe_reversal_id',
      status = case when coalesce(reversed_amount, 0) + (v_reversal->>'amount')::numeric >= amount then 'reversed' else 'paid' end
    where id = (v_reversal->>'payout_id')::uuid;
  end loop;

  -- This dispute has been blocking completion this whole time (see the guards added above), so
  -- if no payout has ever existed for this job, finalize_completion never ran — do that
  -- bookkeeping now, with the admin's adjudicated split rather than the default full cut.
  if not exists (select 1 from payouts where job_id = v_dispute.job_id) then
    perform set_config('app.bypass_chat_guard', 'true', true);
    update chats set customer_ack_at = now(), commission_status = 'earned', reviews_unlocked = true where id = v_dispute.chat_id;
    perform set_config('app.bypass_job_guard', 'true', true);
    update jobs set completed = true, completed_at = now() where id = v_dispute.job_id;

    if p_provider_payout_amount > 0 then
      insert into payouts (job_id, chat_id, payment_id, hauler_id, stripe_connect_account_id, amount, status, created_by)
      select v_dispute.job_id, v_dispute.chat_id,
        (select id from payments where job_id = v_dispute.job_id and kind = 'charge' and status = 'succeeded' order by created_at desc limit 1),
        v_chat.hauler_id, (select stripe_connect_account_id from profiles where id = v_chat.hauler_id),
        p_provider_payout_amount, 'pending', auth.uid()
      returning id into v_new_payout_id;
      perform dispatch_payout_release(v_new_payout_id);
    end if;
  end if;

  update disputes set
    status = p_status, resolved_by = auth.uid(), resolved_at = now(), resolution_in_progress = false,
    refund_amount = p_refund_amount, provider_payout_amount = p_provider_payout_amount, resolution_note = p_note
  where id = p_dispute_id;

  insert into messages (chat_id, sender_role, text)
  values (v_dispute.chat_id, 'system', format('This dispute was resolved by MyTrashBid.%s%s',
    case when p_refund_amount > 0 then format(' $%s refunded to the customer.', p_refund_amount) else '' end,
    case when p_provider_payout_amount > 0 then format(' $%s released to the hauler.', p_provider_payout_amount) else '' end));

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.customer_id, 'disputeResolved', 'Your reported problem was resolved', v_job.title, v_dispute.job_id, v_dispute.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);

  insert into notifications (user_id, event_type, title, body, job_id, chat_id)
  values (v_chat.hauler_id, 'disputeResolved', 'A dispute on your job was resolved', v_job.title, v_dispute.job_id, v_dispute.chat_id)
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
end;
$$;
revoke all on function resolve_dispute(uuid, text, numeric, numeric, jsonb, jsonb, text) from public;
grant all on function resolve_dispute(uuid, text, numeric, numeric, jsonb, jsonb, text) to authenticated;
