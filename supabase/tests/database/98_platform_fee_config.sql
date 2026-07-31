-- Admin-configurable platform fees: super_admin-only by default, toggle-gated for regular admins,
-- every change audited, and the resolved rate frozen onto chats.commission_rate at bid acceptance
-- (never recomputed from a later config change). Fixture 44444444 starts as a full admin,
-- not super_admin — toggled true/false within this transaction as each scenario needs, since it's
-- a persisted 00_setup.sql fixture and this file rolls back at the end regardless.
begin;
select plan(23);

-- ── regular admin, toggle OFF (the default) — blocked from every fee mutation ──────────────────
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select throws_ok(
  $$ select set_global_platform_fee_rate(0.15) $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Regular admins cannot edit platform fees while admin fee edits are turned off.',
  'a regular admin cannot set the global rate while the toggle is off'
);

select throws_ok(
  $$ select set_tier_platform_fee_rate('pro', 0.15) $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Regular admins cannot edit platform fees while admin fee edits are turned off.',
  'a regular admin cannot set a tier rate while the toggle is off'
);

select throws_ok(
  $$ select set_allow_admin_fee_edits(true) $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can change this setting.',
  'a regular admin can never toggle allow_admin_fee_edits itself, on or off'
);

-- ── view-only admin — blocked by is_full_admin() regardless of super_admin/toggle state ─────────
reset role;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
set local role authenticated;

select throws_ok(
  $$ select set_global_platform_fee_rate(0.15) $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Only an admin can change platform fees.',
  'a view-only admin cannot set the global rate'
);

-- ── promote 44444444 to super_admin for this transaction only ───────────────────────────────────
reset role;
update profiles set super_admin = true where id = '44444444-4444-4444-4444-444444444444';
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select throws_ok(
  $$ select set_global_platform_fee_rate(1.5) $$,
  'P0001', 'Platform fee rate must be between 0 and 1.',
  'a rate >= 1 is rejected even for the super admin'
);

select throws_ok(
  $$ select set_tier_platform_fee_rate('bogus', 0.15) $$,
  'P0001', 'Invalid membership tier.',
  'an unrecognized tier name is rejected'
);

select lives_ok(
  $$ select set_global_platform_fee_rate(0.15) $$,
  'the super admin can set the global rate'
);
select is((select global_rate from platform_fee_config), 0.15, 'the global rate actually changed');
select isnt_empty(
  $$ select 1 from platform_fee_audit_log where action = 'global_rate_set' and old_value = '0.1000' and new_value = '0.15' $$,
  'the global rate change is logged with old and new values'
);

select lives_ok(
  $$ select set_tier_platform_fee_rate('pro', 0.05) $$,
  'the super admin can set a tier override'
);
select is(membership_commission_rate('pro'), 0.05, 'the pro tier now resolves to its override, not the global rate');
select is(membership_commission_rate('free'), 0.15, 'a tier with no override still falls back to the (now-changed) global rate');

select lives_ok(
  $$ select set_allow_admin_fee_edits(true) $$,
  'the super admin can turn on admin_fee_edits'
);
select isnt_empty(
  $$ select 1 from platform_fee_audit_log where action = 'admin_edit_toggle_set' and old_value = 'false' and new_value = 'true' $$,
  'the toggle change is logged'
);

-- ── regular admin, toggle now ON — can edit fees, but still can never touch the toggle itself ───
reset role;
update profiles set super_admin = false where id = '44444444-4444-4444-4444-444444444444';
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select lives_ok(
  $$ select set_global_platform_fee_rate(0.12) $$,
  'a regular admin can set the global rate once the toggle is on'
);
select throws_ok(
  $$ select set_allow_admin_fee_edits(false) $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Only the super admin can change this setting.',
  'a regular admin still cannot touch the toggle itself, even with edits allowed'
);

-- ── clearing a tier override falls back to global ────────────────────────────────────────────────
select lives_ok(
  $$ select set_tier_platform_fee_rate('pro', null) $$,
  'a null rate clears the tier override'
);
select is(membership_commission_rate('pro'), 0.12, 'pro now falls back to the global rate again after clearing');

-- ── accept_bid() freezes the resolved rate onto chats.commission_rate — a later config change
-- never reaches back into an already-booked job ─────────────────────────────────────────────────
reset role;
update profiles set super_admin = true where id = '44444444-4444-4444-4444-444444444444';
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;
select lives_ok($$ select set_tier_platform_fee_rate('free', 0.20) $$, 'set the free tier rate to 0.20 ahead of acceptance');

reset role;
-- set_job_expiry() forces new jobs to 'pending_verification' unless the customer's email is
-- verified — the fixture customer has no email_verified_at by default.
update profiles set email_verified_at = now() where id = '11111111-1111-1111-1111-111111111111';
insert into jobs (id, customer_id, title, zip, status, payment_mode)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'pgTAP fee-freeze job', '60629', 'open', 'deposit');
insert into bids (id, job_id, hauler_id, amount)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 100);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
select lives_ok(
  $$ select accept_bid('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') $$,
  'the customer can accept the bid'
);

reset role;
select is(
  (select commission_rate from chats where job_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0.20,
  'the accepted chat stamped the free-tier rate that was in effect at acceptance'
);

update profiles set super_admin = true where id = '44444444-4444-4444-4444-444444444444';
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;
select lives_ok($$ select set_tier_platform_fee_rate('free', 0.35) $$, 'change the free tier rate again, after acceptance');

reset role;
select is(
  (select commission_rate from chats where job_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0.20,
  'the already-accepted job keeps its originally stamped rate, unaffected by the later change'
);

select * from finish();
rollback;
