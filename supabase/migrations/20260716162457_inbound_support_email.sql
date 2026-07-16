-- Lets an inbound email to support@mytrashbid.com (received via AWS SES -> Lambda -> the
-- receive-inbound-email Edge Function) land in the same support_chats/support_messages tables
-- the in-app "Contact Administrator" flow uses, so admins see everything in one place.
--
-- Not every sender will have an account (someone might email before signing up, or from a
-- different address than the one on their profile), so support_chats can now exist without a
-- linked profile — identified by sender_email instead. RLS already handles this correctly with
-- no policy changes: `user_id = auth.uid() or is_admin()` is false for every authenticated user
-- when user_id is null, so these chats are only ever visible to admins.

alter table support_chats
  add column sender_email text,
  alter column user_id drop not null,
  add constraint support_chats_identity_check check (user_id is not null or sender_email is not null);

alter table support_messages
  alter column sender_id drop not null;

alter table support_messages drop constraint support_messages_sender_role_check;
alter table support_messages add constraint support_messages_sender_role_check
  check (sender_role in ('customer', 'hauler', 'admin', 'guest'));

-- These two tables were missed from init_schema.sql's per-table service_role grants — every
-- other table gets `grant all ... to service_role` there, but support_chats/support_messages
-- were added in a later migration and only granted to `authenticated`. RLS's BYPASSRLS on
-- service_role only skips row-level policies, not the base table grant, so the
-- send-support-reply Edge Function's direct `.from("support_messages")` read was failing with
-- "permission denied" until this was added (confirmed the failure before adding this).
grant select on support_chats, support_messages to service_role;

-- Only callable by the trusted inbound-email pipeline (via service_role from the Edge
-- Function) — not exposed to authenticated/anon, since it lets the caller assert an arbitrary
-- "from" email and post as that identity.
create or replace function handle_inbound_support_email(p_email text, p_subject text, p_body text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_profile_id uuid;
  v_profile_role text;
  v_chat_id uuid;
  v_is_new_chat boolean := false;
  v_text text;
begin
  select id, role into v_profile_id, v_profile_role from profiles where lower(email) = v_email limit 1;

  if v_profile_id is not null then
    select id into v_chat_id from support_chats where user_id = v_profile_id and status = 'open' limit 1;
    if v_chat_id is null then
      insert into support_chats (user_id, sender_email) values (v_profile_id, v_email) returning id into v_chat_id;
      v_is_new_chat := true;
    else
      -- Backfills sender_email onto a chat that started in-app (via "Contact Administrator",
      -- which never sets it) the first time this same person emails in on it — otherwise an
      -- admin's reply here would never trigger dispatch_support_reply_email below, since that
      -- only fires when the chat has an email on file.
      update support_chats set sender_email = coalesce(sender_email, v_email) where id = v_chat_id;
    end if;
  else
    select id into v_chat_id from support_chats where sender_email = v_email and user_id is null and status = 'open' limit 1;
    if v_chat_id is null then
      insert into support_chats (sender_email) values (v_email) returning id into v_chat_id;
      v_is_new_chat := true;
    end if;
  end if;

  v_text := case when v_is_new_chat and p_subject is not null and trim(p_subject) <> ''
    then 'Subject: ' || trim(p_subject) || E'\n\n' || p_body
    else p_body
  end;

  insert into support_messages (support_chat_id, sender_id, sender_role, text)
  values (v_chat_id, v_profile_id, coalesce(v_profile_role, 'guest'), v_text);

  return v_chat_id;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default on new functions — must revoke explicitly, or
-- any authenticated user could call this directly and spoof support tickets as an arbitrary
-- "from" email (confirmed this was exploitable before adding the revoke).
revoke execute on function handle_inbound_support_email(text, text, text) from public;
grant execute on function handle_inbound_support_email(text, text, text) to service_role;

-- Emails an admin's reply back to whoever's on the other end of a support_chats row that has an
-- email on file (sender_email is only ever set for chats that involved an inbound email — see
-- above — so a chat that started and stayed purely in-app via "Contact Administrator" correctly
-- never triggers an email here; that person is expected to just see the reply live in the app).
-- Same fire-and-forget pg_net pattern as dispatch_notification_email.
create function dispatch_support_reply_email(p_message_id uuid) returns void
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
    url := v_base_url || '/send-support-reply',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key),
    body := jsonb_build_object('messageId', p_message_id)
  );
exception when others then
  raise warning 'dispatch_support_reply_email failed for %: %', p_message_id, sqlerrm;
end;
$$;

revoke execute on function dispatch_support_reply_email(uuid) from public;

create or replace function assign_support_chat_on_admin_reply() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.sender_role = 'admin' then
    update support_chats set assigned_admin_id = new.sender_id
      where id = new.support_chat_id and assigned_admin_id is null;
    perform dispatch_support_reply_email(new.id);
  end if;
  return new;
end;
$$;
