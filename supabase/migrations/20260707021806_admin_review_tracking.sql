-- MyTrashBid — admin review tracking for the flagged-message and overdue-completion queues.
-- Lets an admin mark an item as "handled" so the dashboard can sort/filter unreviewed-first
-- without losing history (the underlying flag/overdue state itself is untouched).

alter table messages add column flag_reviewed boolean not null default false;
alter table jobs add column overdue_reviewed boolean not null default false;

-- messages had no UPDATE policy at all yet (only select/insert) — admin needs one to toggle
-- flag_reviewed. Scoped to admin only; participants still can't edit messages after sending.
create policy messages_update_admin on messages for update using (is_admin()) with check (is_admin());

-- The RLS policy alone isn't enough — the platform's default is to grant nothing beyond what
-- was explicitly listed for a table (see the grants block at the end of init_schema.sql), and
-- that block only ever gave `authenticated` select+insert on messages, not update.
grant update on messages to authenticated;
