-- MyTrashBid — closing a support ticket
--
-- An admin can now mark a support ticket resolved, which drops it out of loadOpenSupportChats()'s
-- queue (already filtered to status = 'open' — no change needed there). A reply from the
-- requester's side automatically flips it back open so nothing quietly falls through the cracks.
-- Closing leaves a note in the thread ("Chat closed by <name>") that only admins ever see — a real
-- column-level split enforced by the select policy below, not just a UI convention.

alter table support_chats add column closed_at timestamptz;
alter table support_chats add column closed_by uuid references profiles(id);
alter table support_messages add column admin_only boolean not null default false;

drop policy support_messages_select on support_messages;
create policy support_messages_select on support_messages for select using (
  exists (select 1 from support_chats sc where sc.id = support_chat_id and (
    (sc.user_id = auth.uid() and not admin_only) or is_admin()
  ))
);

-- Tightened alongside: the previous insert policy never checked sender_role or admin_only at all,
-- so a customer/hauler could set sender_role = 'admin' (or admin_only = true) on their own insert
-- and impersonate a support reply in their own thread. This only governs direct client inserts —
-- close_support_chat() and handle_inbound_support_email() are SECURITY DEFINER and bypass it.
drop policy support_messages_insert on support_messages;
create policy support_messages_insert on support_messages for insert with check (
  exists (select 1 from support_chats sc where sc.id = support_chat_id and (
    (sc.user_id = auth.uid() and sender_role <> 'admin' and not admin_only) or is_full_admin()
  ))
);

create function close_support_chat(p_support_chat_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_admin_name text;
begin
  if not is_full_admin() then
    raise exception 'Only full admins can close support tickets';
  end if;

  select name into v_admin_name from profiles where id = auth.uid();

  update support_chats set status = 'closed', closed_at = now(), closed_by = auth.uid()
  where id = p_support_chat_id;

  insert into support_messages (support_chat_id, sender_id, sender_role, text, admin_only)
  values (p_support_chat_id, auth.uid(), 'admin', format('Chat closed by %s', coalesce(v_admin_name, 'an admin')), true);
end;
$$;

grant execute on function close_support_chat(uuid) to authenticated;

-- Fires for every support_messages insert regardless of path (direct client insert or the
-- SECURITY DEFINER functions above) — a reply from anyone but an admin reopens a closed ticket.
create function reopen_support_chat_on_reply() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.sender_role <> 'admin' then
    update support_chats set status = 'open' where id = new.support_chat_id and status = 'closed';
  end if;
  return new;
end;
$$;

create trigger support_messages_reopen after insert on support_messages
  for each row execute function reopen_support_chat_on_reply();
