-- MyTrashBid — SMS kill switch
--
-- AWS SNS is fully wired (credentials provisioned, all dispatch paths built and tested), but SMS
-- is being held back for now while the product focuses on email notifications — texting needs its
-- own opt-in moment at login before it should actually reach anyone. Rather than touching
-- send-sms-notification or ripping out AWS credentials, this adds a single admin_config off-switch
-- that both SMS dispatch entry points check first — flipping it back to 'true' later re-enables
-- every existing SMS path (digest, bid-accepted, new-message streak alerts, etc.) with zero code
-- changes or redeploys.

insert into app_config (key, value) values ('sms_notifications_enabled', 'false')
  on conflict (key) do nothing;

create or replace function dispatch_notification_sms(p_notification_id uuid) returns void
  language plpgsql security definer set search_path = public as $$
  declare
    v_enabled text;
    v_base_url text;
    v_key text;
  begin
    select value into v_enabled from app_config where key = 'sms_notifications_enabled';
    if v_enabled is distinct from 'true' then
      return;
    end if;
    select value into v_base_url from app_config where key = 'functions_base_url';
    select value into v_key from app_config where key = 'internal_dispatch_key';
    if v_base_url is null or v_base_url = '' then
      return;
    end if;
    perform net.http_post(
      url := v_base_url || '/send-sms-notification',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('notificationId', p_notification_id)
    );
  exception when others then
    raise warning 'dispatch_notification_sms failed for %: %', p_notification_id, sqlerrm;
  end;
  $$;

create or replace function dispatch_new_job_sms_digest() returns void
  language plpgsql security definer set search_path = public as $$
  declare
    v_enabled text;
    v_base_url text;
    v_key text;
  begin
    select value into v_enabled from app_config where key = 'sms_notifications_enabled';
    if v_enabled is distinct from 'true' then
      return;
    end if;
    select value into v_base_url from app_config where key = 'functions_base_url';
    select value into v_key from app_config where key = 'internal_dispatch_key';
    if v_base_url is null or v_base_url = '' then
      return;
    end if;
    perform net.http_post(
      url := v_base_url || '/send-sms-notification',
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
      body := jsonb_build_object('digest', true)
    );
  exception when others then
    raise warning 'dispatch_new_job_sms_digest failed: %', sqlerrm;
  end;
  $$;
