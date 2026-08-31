-- admin_load_pending_payouts() never actually returned customer_id, even though PayoutsTab.jsx's
-- UserLink for the customer expects it — a real bug caught before anyone hit it live (UserLink
-- degrades to plain unlinked text when id is missing, so this was silent, not broken).

drop function if exists admin_load_pending_payouts();

create function admin_load_pending_payouts()
returns table (
  id uuid, job_id uuid, chat_id uuid, hauler_id uuid, customer_id uuid, amount numeric, created_at timestamptz,
  job_title text, hauler_name text, hauler_business_name text, customer_name text
)
language sql stable security definer set search_path = public as $$
  select po.id, po.job_id, po.chat_id, po.hauler_id, j.customer_id, po.amount, po.created_at,
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
