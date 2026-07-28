-- Admin hard-delete of a customer/hauler account — deliberately scoped to accounts with zero
-- real activity. jobs/bids/chats/messages/cancellation_requests/etc. all reference profiles(id)
-- with ON DELETE NO ACTION (see FK audit done before writing this), so rather than duplicating
-- a table-by-table "does this user have any history" check in application code, this just
-- attempts the delete and lets Postgres's own referential integrity reject it — future-proof
-- against any new table added later that references profiles(id) without cascade.
--
-- profiles.id -> auth.users(id) is ON DELETE CASCADE, so deleting the auth.users row is
-- sufficient; the profiles row (and anything that cascades from IT — hauler_documents,
-- notifications, admin_user_flags, hauler_dismissed_jobs, profile_zip_history,
-- profile_change_requests.hauler_id) cleans up automatically.
create or replace function admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_role text;
begin
  if not is_full_admin() then
    raise exception 'Only a full admin can delete a user.';
  end if;
  perform require_aal2();

  select role into v_target_role from profiles where id = p_user_id;
  if v_target_role is null then
    raise exception 'User not found.';
  end if;
  if v_target_role = 'admin' then
    raise exception 'Admin accounts cannot be deleted here.';
  end if;

  begin
    delete from auth.users where id = p_user_id;
  exception when foreign_key_violation then
    raise exception 'This account has activity (a job, bid, chat, or similar) and can''t be deleted — deactivate it instead.';
  end;
end;
$$;

grant execute on function admin_delete_user(uuid) to authenticated;
