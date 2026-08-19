-- pgTAP fixtures for the admin-chat-participation test suite.
--
-- Deliberately NOT wrapped in begin/rollback — these rows persist (idempotently, via
-- "on conflict do nothing") across every numbered test file below, so each file below only has
-- to declare its own begin/rollback around the behavior it's actually testing, not re-create a
-- customer/hauler/admin/job/chat from scratch every time. Fixed, memorable UUIDs so every file
-- can reference them as plain literals. Wiped clean the next time `supabase db reset` runs, same
-- as any other local-only dev state.
create extension if not exists pgtap;
select plan(1);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'pgtap-customer@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'pgtap-hauler@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'pgtap-other-customer@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'pgtap-full-admin@example.com'),
  ('55555555-5555-5555-5555-555555555555', 'pgtap-readonly-admin@example.com')
on conflict (id) do nothing;

-- role/admin_read_only are guarded by guard_profile_self_update() the same as every other
-- privileged column (verified, territory_id, ...) as of 20260905020000_medium_findings_backend.sql
-- (ported audit finding M-6) — a raw UPDATE with no bypass flag now correctly fails even from
-- this fixture's own superuser session, exactly as it would for a real admin trying to
-- self-promote.
--
-- is_local = false (not true): this file runs unwrapped, so each statement autocommits in its
-- own transaction — a transaction-local (is_local = true) setting would revert before the next
-- line ever saw it. false makes it session-scoped, so it survives across these three statements.
select set_config('app.bypass_profile_guard', 'true', false);
update profiles set role = 'hauler' where id = '22222222-2222-2222-2222-222222222222';
update profiles set role = 'admin', admin_read_only = false where id = '44444444-4444-4444-4444-444444444444';
update profiles set role = 'admin', admin_read_only = true where id = '55555555-5555-5555-5555-555555555555';
select set_config('app.bypass_profile_guard', 'false', false);

insert into jobs (id, customer_id, title, zip, status, payment_mode)
values ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'pgTAP test job', '60629', 'booked', 'full')
on conflict (id) do nothing;

insert into chats (id, job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode)
values ('77777777-7777-7777-7777-777777777777', '66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 100, 0, 0, 10, 'full')
on conflict (id) do nothing;

select pass('pgTAP fixtures loaded');
select * from finish();
