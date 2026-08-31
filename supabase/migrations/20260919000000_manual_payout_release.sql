-- Payout release moves from automatic (fires the instant a job is confirmed complete) to
-- admin-driven: finalize_completion() still does all the same bookkeeping and still inserts the
-- payouts row the moment a job is confirmed complete (customer ack or the 48h auto-ack timeout —
-- both funnel through here already), it just stops calling dispatch_payout_release() itself. The
-- payout sits in the existing `pending` status as a real queue until an admin releases it.
--
-- Gated by app_config.payout_release_mode ('manual' | 'automatic', default 'manual' per this
-- request) rather than ripping the automatic path out — flipping it back to 'automatic' restores
-- the exact prior behavior with no code change, just a super-admin-only toggle (same permission
-- tier as MoneyPolicyTab's allow_admin_fee_edits switch).

insert into app_config (key, value) values ('payout_release_mode', 'manual')
on conflict (key) do nothing;

-- ─── 1. released_by — which admin actually pulled the trigger in manual mode. released_at already
--    exists and is set by process-payout-release once the real Stripe transfer succeeds; this is
--    stamped earlier, at the moment of admin authorization, same idea as suspended_by_admin_id /
--    moderated_by_admin_id elsewhere. Null for anything released automatically (no admin acted). ──

alter table payouts add column released_by uuid references profiles(id);

-- ─── 2. finalize_completion() — byte-for-byte the current 20260908000000_payouts_and_release.sql
--    definition, just wrapping the release dispatch in the mode check. ────────────────────────────

create or replace function finalize_completion(p_chat chats, p_job jobs, p_auto boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_notif_id uuid;
  v_payout_id uuid;
  v_payment_id uuid;
  v_connect_account_id text;
  v_release_mode text;
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

  select value into v_release_mode from app_config where key = 'payout_release_mode';
  if coalesce(v_release_mode, 'manual') = 'automatic' then
    perform dispatch_payout_release(v_payout_id);
  end if;
end;
$$;

-- ─── 3. set_payout_release_mode() — super-admin-only, same tier as allow_admin_fee_edits. ─────────

create function set_payout_release_mode(p_mode text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can change how payouts are released.';
  end if;
  if p_mode not in ('manual', 'automatic') then
    raise exception 'Invalid release mode.';
  end if;
  insert into app_config (key, value) values ('payout_release_mode', p_mode)
  on conflict (key) do update set value = excluded.value;
end;
$$;
revoke execute on function set_payout_release_mode(text) from public;
grant execute on function set_payout_release_mode(text) to authenticated;

-- ─── 4. admin_release_payout() — the manual trigger, full-admin (same tier as close_support_chat /
--    admin_suspend_user, not super-admin-only — releasing a specific, already-queued payout is an
--    operational task, not a policy change). require_aal2() since this is the one action that
--    actually moves money. ──────────────────────────────────────────────────────────────────────

create function admin_release_payout(p_payout_id uuid, p_client_user_agent text default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_payout payouts%rowtype;
begin
  if not is_full_admin() then
    raise exception 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can release a payout.';
  end if;
  perform require_aal2();

  select * into v_payout from payouts where id = p_payout_id for update;
  if v_payout.id is null then
    raise exception 'Payout not found.';
  end if;
  if v_payout.status <> 'pending' then
    raise exception 'This payout is not pending release.';
  end if;

  update payouts set released_by = auth.uid() where id = p_payout_id;
  perform dispatch_payout_release(p_payout_id);
end;
$$;
revoke execute on function admin_release_payout(uuid, text) from public;
grant execute on function admin_release_payout(uuid, text) to authenticated;

-- ─── 5. admin_load_pending_payouts() — joined read for the queue UI. A SECURITY DEFINER RPC rather
--    than a plain embedded-select from the client: jobs_select scopes a territory admin's job
--    visibility, which would silently null out the embed for jobs outside their territory instead
--    of erroring (same PostgREST-embed-RLS gotcha worked around elsewhere this session) — a
--    definer function sidesteps it entirely, same idiom as check_account_deletion_blockers. ──────

create function admin_load_pending_payouts()
returns table (
  id uuid, job_id uuid, chat_id uuid, hauler_id uuid, amount numeric, created_at timestamptz,
  job_title text, hauler_name text, hauler_business_name text, customer_name text
)
language sql stable security definer set search_path = public as $$
  select po.id, po.job_id, po.chat_id, po.hauler_id, po.amount, po.created_at,
    j.title, hp.name, hp.business_name, cp.name
  from payouts po
  join jobs j on j.id = po.job_id
  join profiles hp on hp.id = po.hauler_id
  join profiles cp on cp.id = j.customer_id
  where po.status = 'pending' and is_admin()
  order by po.created_at asc;
$$;
revoke execute on function admin_load_pending_payouts() from public;
grant execute on function admin_load_pending_payouts() to authenticated;
