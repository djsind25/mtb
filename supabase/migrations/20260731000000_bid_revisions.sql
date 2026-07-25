-- Append-only bid revisions ("change orders") for a booked-but-not-completed job. The original
-- bid row and its accept-time chat snapshot (chats.bid_amount/deposit/balance_due/commission —
-- already protected from self-edit by guard_chat_self_update) are never touched; a revision is a
-- new ledger row, plus a system chat message, plus (once the customer resolves it) another system
-- message recording the outcome. Nothing here changes what MyTrashBid actually charged or holds —
-- deliberately out of scope. This is a "what price did the two of them agree to" ledger, not a
-- repricing of money already collected via Stripe.
--
-- Gated behind app_config.change_orders_enabled (default 'false', set_change_orders_enabled is
-- super-admin-only) so this can ship dark and be turned on when ready.

insert into app_config (key, value) values ('change_orders_enabled', 'false') on conflict (key) do nothing;

create function set_change_orders_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then
    raise exception 'Only the super admin can change this setting';
  end if;
  update app_config set value = case when p_enabled then 'true' else 'false' end where key = 'change_orders_enabled';
end;
$$;
grant execute on function set_change_orders_enabled(boolean) to authenticated;

-- app_config's own SELECT policy is admin-only (app_config_select_all requires is_admin()), so a
-- hauler/customer client can't just query the table directly the way admin screens do — this is
-- the narrow read-only escape hatch for the one key non-admin UI needs to check.
create function is_change_orders_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_config where key = 'change_orders_enabled'), 'false') = 'true';
$$;
grant execute on function is_change_orders_enabled() to authenticated;

create table bid_revisions (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references jobs(id) on delete cascade,
  chat_id     uuid not null references chats(id) on delete cascade,
  hauler_id   uuid not null references profiles(id),
  customer_id uuid not null references profiles(id),
  old_amount  numeric(10, 2) not null,
  new_amount  numeric(10, 2) not null,
  reason      text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

alter table bid_revisions enable row level security;
create policy bid_revisions_select on bid_revisions for select using (
  hauler_id = auth.uid() or customer_id = auth.uid() or is_admin()
);
-- No insert/update policy at all — same shape as hauler_documents/profile_change_requests: every
-- write goes through the two security-definer RPCs below, which is what actually makes this
-- append-only from a client's perspective (there's no path to editing a row post-insert except
-- resolve_bid_revision flipping pending -> approved/declined once).
grant select on bid_revisions to authenticated, service_role;

-- One pending revision at a time per job — resolve the current one before proposing another,
-- so the customer is never asked to track more than one open price question. old_amount is
-- computed server-side from the latest *approved* revision (or the original chat snapshot if
-- none), never trusted from the client.
create function propose_bid_revision(p_job_id uuid, p_new_amount numeric, p_reason text default null)
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
    format('💰 %s proposed a new price: $%s → $%s.%s', v_hauler_name, v_old_amount, p_new_amount::numeric(10,2),
      case when p_reason is not null and p_reason <> '' then ' Reason: ' || p_reason else '' end)
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
grant execute on function propose_bid_revision(uuid, numeric, text) to authenticated;

-- Declining leaves old_amount as the standing price — nothing to undo, since nothing was ever
-- applied anywhere except this row's own status.
create function resolve_bid_revision(p_revision_id uuid, p_approved boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rev bid_revisions%rowtype;
  v_job jobs%rowtype;
  v_notif_id uuid;
begin
  select * into v_rev from bid_revisions where id = p_revision_id for update;
  if v_rev.id is null then
    raise exception 'Revision not found';
  end if;
  if v_rev.customer_id <> auth.uid() then
    raise exception 'Only the customer on this job can respond to a price revision';
  end if;
  if v_rev.status <> 'pending' then
    raise exception 'This price revision has already been resolved';
  end if;

  update bid_revisions set status = case when p_approved then 'approved' else 'declined' end, resolved_at = now()
    where id = p_revision_id;

  insert into messages (chat_id, sender_role, text) values (
    v_rev.chat_id, 'system',
    case when p_approved
      then format('✓ Customer approved the new price: $%s.', v_rev.new_amount)
      else format('✗ Customer declined the new price — $%s stands.', v_rev.old_amount)
    end
  );

  select * into v_job from jobs where id = v_rev.job_id;
  insert into notifications (user_id, event_type, title, body, job_id)
    values (v_rev.hauler_id, 'bidRevisionResolved',
      case when p_approved then 'Price change approved on "' || v_job.title || '"' else 'Price change declined on "' || v_job.title || '"' end,
      case when p_approved then format('New price: $%s', v_rev.new_amount) else format('Customer kept the original price: $%s', v_rev.old_amount) end,
      v_rev.job_id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;
grant execute on function resolve_bid_revision(uuid, boolean) to authenticated;

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered',
  'bidRevisionProposed', 'bidRevisionResolved'
]));

alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": true,
    "jobCompleted": true,
    "reminderOverdue": true,
    "jobBooked": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true
  },
  "smsEvents": {
    "newJobNearby": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true,
    "adminMessage": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  jsonb_set(
    notification_prefs,
    '{events}',
    coalesce(notification_prefs->'events', '{}'::jsonb) || '{"bidRevisionProposed": true, "bidRevisionResolved": true}'::jsonb
  ),
  '{smsEvents}',
  coalesce(notification_prefs->'smsEvents', '{}'::jsonb) || '{"bidRevisionProposed": true, "bidRevisionResolved": true}'::jsonb
);
