-- Two gaps, both surfaced by manual payout release becoming the default: job_reversible_payouts()
-- only ever looked at status='paid' rows, so a dispute resolved while the job's payout was still
-- sitting pending (now the normal case for hours/days, not a rare timing edge) never touched that
-- row at all — releasing it later would still pay the hauler's full original share on top of
-- whatever the customer was just refunded. And the "no payout existed yet" branch's own
-- dispatch_payout_release() call was unconditional, bypassing payout_release_mode entirely for a
-- dispute-created payout even when the global setting is 'manual'.

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
  v_pending_payout_id uuid;
  v_release_mode text;
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

  select id into v_pending_payout_id from payouts where job_id = v_dispute.job_id and status = 'pending';

  if v_pending_payout_id is not null then
    -- Nothing was ever transferred for this payout yet (that's the reversal loop's job, above) —
    -- just correct the queued amount to what the admin actually approved, so releasing it later
    -- (still through the normal manual/automatic path, untouched by this dispute) pays the right
    -- figure. Zero means the hauler gets nothing from this job at all: delete rather than leave a
    -- row that violates payouts_amount_check (amount > 0).
    if p_provider_payout_amount > 0 then
      update payouts set amount = p_provider_payout_amount where id = v_pending_payout_id;
    else
      delete from payouts where id = v_pending_payout_id;
    end if;
  -- This dispute has been blocking completion this whole time (see the guards added when disputes
  -- were built), so if no payout has ever existed for this job, finalize_completion never ran —
  -- do that bookkeeping now, with the admin's adjudicated split rather than the default full cut.
  elsif not exists (select 1 from payouts where job_id = v_dispute.job_id) then
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

      select value into v_release_mode from app_config where key = 'payout_release_mode';
      if coalesce(v_release_mode, 'manual') = 'automatic' then
        perform dispatch_payout_release(v_new_payout_id);
      end if;
    end if;
  end if;

  update disputes set
    status = p_status, resolved_by = auth.uid(), resolved_at = now(), resolution_in_progress = false,
    refund_amount = p_refund_amount, provider_payout_amount = p_provider_payout_amount, resolution_note = p_note
  where id = p_dispute_id;

  -- "queued for" rather than "released to" — accurate regardless of payout_release_mode: an
  -- automatic release may already be in flight by the time this reads, a manual one is still
  -- sitting in the admin queue, and this message shouldn't claim more certainty than either case.
  insert into messages (chat_id, sender_role, text)
  values (v_dispute.chat_id, 'system', format('This dispute was resolved by MyTrashBid.%s%s',
    case when p_refund_amount > 0 then format(' $%s refunded to the customer.', p_refund_amount) else '' end,
    case when p_provider_payout_amount > 0 then format(' $%s queued for the hauler.', p_provider_payout_amount) else '' end));

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
