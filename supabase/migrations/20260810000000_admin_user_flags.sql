-- Admin-side manual user flagging: distinct from the existing automatic content-level flag_type
-- system (messages/job_questions/job_updates, which flags individual off-platform-contact attempts
-- as they happen). This is a manual, admin-initiated note on a *user* — e.g. "this hauler's bids
-- keep falling through" or "repeated circumvention attempts across multiple chats" — something a
-- pattern review surfaces that no single automatic content flag would catch on its own.
--
-- Append-only log (one row per flag event, never overwritten) rather than a single mutable column
-- on profiles, so the history of why/when/by-whom survives even after a flag is resolved — matches
-- this codebase's established append-only pattern for cancellations/bid-revisions.
create table admin_user_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  flagged_by uuid not null references profiles(id),
  reason_type text not null check (reason_type in ('circumvention', 'cancellation_pattern', 'other')),
  note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id)
);
create index admin_user_flags_user_id_idx on admin_user_flags(user_id);

alter table admin_user_flags enable row level security;

-- Read-only for admins (including view-only) — matches the "full visibility" posture the rest of
-- the admin dashboard already has. Mutations only ever go through the RPCs below, which check
-- is_full_admin() themselves — no insert/update policy needed since nothing here bypasses RLS to
-- write directly from the client.
grant select on admin_user_flags to authenticated;
create policy admin_user_flags_select on admin_user_flags for select using (is_admin());

create function admin_flag_user(p_user_id uuid, p_reason_type text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_target_role text;
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can flag a user.';
  end if;
  if p_reason_type not in ('circumvention', 'cancellation_pattern', 'other') then
    raise exception 'Invalid reason type.';
  end if;

  select role into v_target_role from profiles where id = p_user_id;
  if v_target_role is null then
    raise exception 'User not found.';
  end if;
  if v_target_role = 'admin' then
    raise exception 'Admin accounts cannot be flagged.';
  end if;

  insert into admin_user_flags (user_id, flagged_by, reason_type, note)
    values (p_user_id, auth.uid(), p_reason_type, nullif(trim(p_note), ''))
    returning id into v_id;
  return v_id;
end;
$$;

grant execute on function admin_flag_user(uuid, text, text) to authenticated;

create function admin_resolve_user_flag(p_flag_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can resolve a flag.';
  end if;

  update admin_user_flags set resolved_at = now(), resolved_by = auth.uid()
    where id = p_flag_id and resolved_at is null;
end;
$$;

grant execute on function admin_resolve_user_flag(uuid) to authenticated;
