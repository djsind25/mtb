-- MyTrashBid — send-monthly-export was the one internal-dispatch function that took its recipient
-- email and all its financial content directly from the request body instead of looking them up
-- from the DB itself (every other dispatch function — send-verification-email,
-- send-account-deletion-email, send-support-reply, send-admin-invite, send-notification — takes an
-- opaque id and resolves recipient/content server-side). If the shared INTERNAL_DISPATCH_KEY ever
-- leaked, this was the one endpoint that could be turned into an open relay for attacker-chosen
-- email content to an attacker-chosen address. Fixed by moving the computation dispatch_monthly_
-- export() already did into its own service_role-only function, and having the edge function pull
-- the data itself (via ctx.supabaseAdmin.rpc(...), same pattern switch-bid-payment already uses
-- for finalize_bid_switch) instead of trusting whatever the POST body says.

-- Byte-for-byte the same computation dispatch_monthly_export() had inline — just extracted so the
-- edge function can call it directly instead of receiving its output over the wire from a caller
-- that could, in principle, be anyone who has the shared key.
create function get_monthly_export_data(p_month_start date, p_month_end date) returns jsonb
  language plpgsql security definer set search_path = public as $$
declare
  v_super_email text;
  v_month_label text;
  v_revenue jsonb;
  v_jobs jsonb;
  v_rate numeric;
begin
  select email into v_super_email from profiles where role = 'admin' and super_admin limit 1;
  if v_super_email is null then
    return null;
  end if;

  v_month_label := to_char(p_month_start, 'Mon YYYY');
  v_rate := (select global_rate from platform_fee_config);

  select jsonb_build_object(
    'bookedJobs', count(*),
    'gmv', coalesce(sum(b.amount), 0),
    'deposit', coalesce(sum(b.amount) * v_rate, 0),
    'haulerDirect', coalesce(sum(b.amount) * (1 - v_rate), 0)
  ) into v_revenue
  from jobs j
  join bids b on b.id = j.accepted_bid_id
  where j.status = 'booked'
    and j.payment_mode = 'deposit'
    and coalesce(j.accepted_at, j.created_at)::date between p_month_start and p_month_end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'title', j.title,
    'customer', cp.name,
    'hauler', coalesce(hp.business_name, hp.name),
    'amount', b.amount,
    'completedAt', j.completed_at
  ) order by j.completed_at), '[]'::jsonb) into v_jobs
  from jobs j
  join bids b on b.id = j.accepted_bid_id
  join profiles cp on cp.id = j.customer_id
  join profiles hp on hp.id = b.hauler_id
  where j.completed = true
    and j.completed_at::date between p_month_start and p_month_end;

  return jsonb_build_object(
    'email', v_super_email, 'monthLabel', v_month_label, 'revenue', v_revenue, 'completedJobs', v_jobs
  );
end;
$$;
revoke execute on function get_monthly_export_data(date, date) from public;
grant execute on function get_monthly_export_data(date, date) to service_role;

-- dispatch_monthly_export() now only tells the edge function WHICH month to export — the edge
-- function looks up who/what itself via get_monthly_export_data(), so a leaked shared key can no
-- longer be used to email arbitrary content to an arbitrary address through this endpoint.
create or replace function dispatch_monthly_export(p_month_start date, p_month_end date) returns void
  language plpgsql security definer set search_path = public as $$
declare
  v_base_url text;
  v_key text;
begin
  select value into v_base_url from app_config where key = 'functions_base_url';
  select value into v_key from app_config where key = 'internal_dispatch_key';
  if v_base_url is null or v_base_url = '' then
    return;
  end if;

  perform net.http_post(
    url := v_base_url || '/send-monthly-export',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object('monthStart', p_month_start, 'monthEnd', p_month_end)
  );
exception when others then
  raise warning 'dispatch_monthly_export failed: %', sqlerrm;
end;
$$;
