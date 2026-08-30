-- Support chats never auto-closed — once opened, a general or per-job ticket sat "open" forever
-- unless an admin manually resolved it, even with weeks of silence on both sides. Auto-close
-- after a configurable period of inactivity (default 7 days), then let either side — the
-- requester or an admin — explicitly reopen it rather than leaving it to accumulate in the open
-- queue (the same queue loadSupportChats() was just fixed to stop counting zero-message chats in).

insert into app_config (key, value) values ('support_chat_auto_close_days', '7')
on conflict (key) do nothing;

-- Closes any support_chats row whose most recent activity (last message, or its own created_at
-- if it somehow has none) is older than the configured window. closed_by is left null — that's
-- how the frontend tells "auto-closed" apart from "an admin explicitly resolved this" (see
-- close_support_chat, which always sets closed_by = auth.uid()).
create function auto_close_stale_support_chats() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_days numeric := app_config_numeric('support_chat_auto_close_days');
begin
  update support_chats sc set status = 'closed', closed_at = now()
  where sc.status = 'open'
    and coalesce(
      (select max(sm.created_at) from support_messages sm where sm.support_chat_id = sc.id),
      sc.created_at
    ) <= now() - make_interval(days => v_days::int);
end;
$$;
revoke execute on function auto_close_stale_support_chats() from public;

-- Daily is plenty of granularity for a days-scale window — matches the existing daily cron slot
-- (overdue-completion-reminders, hauler-document-expirations) rather than needing the 15-minute
-- cadence the 48h payout-release window needs.
select cron.schedule('auto-close-stale-support-chats', '0 13 * * *', $cron$select auto_close_stale_support_chats()$cron$);

-- Either side can explicitly reopen a closed ticket. A requester replying already reopens it
-- automatically (reopen_support_chat_on_reply, unchanged), but that only fires once they've
-- actually typed something — this covers the "let me back in" click that comes before that, and
-- is the only path back in for an admin at all (admin replies deliberately do NOT auto-reopen).
create function reopen_support_chat(p_support_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (
    is_full_admin()
    or exists (select 1 from support_chats where id = p_support_chat_id and user_id = auth.uid())
  ) then
    raise exception 'You do not have access to this ticket';
  end if;

  update support_chats set status = 'open', closed_at = null, closed_by = null
  where id = p_support_chat_id and status = 'closed';
end;
$$;
revoke execute on function reopen_support_chat(uuid) from public;
grant execute on function reopen_support_chat(uuid) to authenticated;
