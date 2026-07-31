-- MyTrashBid — require a reason on bid-revision ("propose new price") proposals, matching the
-- same requirement already placed on cancellation requests (20260813000000): a blank reason makes
-- it hard for the customer to judge whether a price change is legitimate, and hard for admins
-- reviewing a dispute later. Same convention: raise before any other server-side check that
-- doesn't need to run first, `create or replace` with the same signature so no client/RPC-name
-- change is needed beyond passing a non-blank reason.
create or replace function propose_bid_revision(p_job_id uuid, p_new_amount numeric, p_reason text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_chat chats%rowtype;
  v_old_amount numeric;
  v_revision_id uuid;
  v_notif_id uuid;
  v_hauler_name text;
begin
  if coalesce((select value from app_config where key = 'change_orders_enabled'), 'false') <> 'true' then
    raise exception 'Price revisions are not enabled yet.';
  end if;
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'A reason is required to propose a price revision.';
  end if;
  if p_new_amount is null or p_new_amount <= 0 then
    raise exception 'Enter a valid amount.';
  end if;

  select * into v_job from jobs where id = p_job_id;
  if v_job.id is null or v_job.status <> 'booked' or v_job.completed then
    raise exception 'This job is not eligible for a price revision.';
  end if;

  select * into v_chat from chats where job_id = p_job_id and superseded_at is null;
  if v_chat.id is null or v_chat.hauler_id <> auth.uid() then
    raise exception 'Only the hauler on this job can propose a price revision';
  end if;

  if exists (select 1 from bid_revisions where job_id = p_job_id and status = 'pending') then
    raise exception 'A price revision is already pending on this job — wait for the customer to respond.';
  end if;

  select coalesce(
    (select new_amount from bid_revisions where job_id = p_job_id and status = 'approved' order by resolved_at desc limit 1),
    v_chat.bid_amount
  ) into v_old_amount;

  if p_new_amount = v_old_amount then
    raise exception 'The new price must be different from the current price.';
  end if;

  insert into bid_revisions (job_id, chat_id, hauler_id, customer_id, old_amount, new_amount, reason)
  values (p_job_id, v_chat.id, auth.uid(), v_chat.customer_id, v_old_amount, p_new_amount, p_reason)
  returning id into v_revision_id;

  select coalesce(business_name, name) into v_hauler_name from profiles where id = auth.uid();

  insert into messages (chat_id, sender_role, text) values (
    v_chat.id, 'system',
    format('💰 %s proposed a new price: $%s → $%s. Reason: %s', v_hauler_name, v_old_amount, p_new_amount::numeric(10,2), p_reason)
  );

  insert into notifications (user_id, event_type, title, body, job_id)
    values (v_chat.customer_id, 'bidRevisionProposed', 'New price proposed for "' || v_job.title || '"',
      format('$%s → $%s — review and respond in chat.', v_old_amount, p_new_amount), p_job_id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);

  return v_revision_id;
end;
$$;
