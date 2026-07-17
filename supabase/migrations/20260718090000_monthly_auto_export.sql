-- MyTrashBid — monthly revenue + completed-jobs auto-export to the super admin's email
--
-- Security fix found while building this: app_config_select_all used `using (true)`, so any
-- authenticated customer or hauler (not just admins) could read every app_config row directly via
-- the REST API — including internal_dispatch_key, the shared secret every internal-only Edge
-- Function (send-notification, send-verification-email, send-support-reply, send-admin-invite,
-- receive-inbound-email) trusts for its own auth check. Nothing in the frontend ever reads
-- app_config directly (all access goes through SECURITY DEFINER helpers like app_config_numeric(),
-- which bypass RLS entirely), so restricting reads to admins closes a real hole with zero features
-- lost.
drop policy app_config_select_all on app_config;
create policy app_config_select_all on app_config for select using (is_admin());

insert into app_config (key, value) values ('auto_export_enabled', 'false') on conflict (key) do nothing;

create function set_auto_export_enabled(p_enabled boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then
    raise exception 'Only the super admin can change this setting';
  end if;
  update app_config set value = case when p_enabled then 'true' else 'false' end where key = 'auto_export_enabled';
end;
$$;

grant execute on function set_auto_export_enabled(boolean) to authenticated;

create function dispatch_monthly_export(p_month_start date, p_month_end date) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_super_email text;
  v_month_label text;
  v_base_url text;
  v_key text;
  v_revenue jsonb;
  v_jobs jsonb;
  v_rate numeric;
begin
  select email into v_super_email from profiles where role = 'admin' and super_admin limit 1;
  if v_super_email is null then
    return;
  end if;

  v_month_label := to_char(p_month_start, 'Mon YYYY');
  v_rate := app_config_numeric('commission_rate');

  select jsonb_build_object(
    'bookedJobs', count(*),
    'gmv', coalesce(sum(b.amount), 0),
    'deposit', coalesce(sum(b.amount) * v_rate, 0),
    'haulerDirect', coalesce(sum(b.amount) * (1 - v_rate), 0)
  ) into v_revenue
  from jobs j
  join bids b on b.id = j.accepted_bid_id
  where j.status = 'booked'
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

  select value into v_base_url from app_config where key = 'functions_base_url';
  select value into v_key from app_config where key = 'internal_dispatch_key';
  if v_base_url is null or v_base_url = '' then
    return;
  end if;

  perform net.http_post(
    url := v_base_url || '/send-monthly-export',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object(
      'email', v_super_email,
      'monthLabel', v_month_label,
      'revenue', v_revenue,
      'completedJobs', v_jobs
    )
  );
exception when others then
  raise warning 'dispatch_monthly_export failed: %', sqlerrm;
end;
$$;

-- Cron-invoked: runs with no auth context at all, so it gates on the app_config toggle instead of
-- is_super_admin() — reports the just-completed prior calendar month.
create function run_monthly_export() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_enabled text;
begin
  select value into v_enabled from app_config where key = 'auto_export_enabled';
  if coalesce(v_enabled, 'false') <> 'true' then
    return;
  end if;

  perform dispatch_monthly_export(
    (date_trunc('month', current_date) - interval '1 month')::date,
    (date_trunc('month', current_date) - interval '1 day')::date
  );
end;
$$;

select cron.schedule('monthly-revenue-export', '0 9 1 * *', $cron$select run_monthly_export()$cron$);

-- Manual trigger for the "Send test export now" button — a real admin session, so this checks
-- is_super_admin() directly instead of the toggle (letting the super admin verify the email even
-- while auto-export is switched off).
create function send_monthly_export_now() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then
    raise exception 'Only the super admin can send this';
  end if;

  perform dispatch_monthly_export(
    (date_trunc('month', current_date) - interval '1 month')::date,
    (date_trunc('month', current_date) - interval '1 day')::date
  );
end;
$$;

grant execute on function send_monthly_export_now() to authenticated;
