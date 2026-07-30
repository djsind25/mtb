-- Suspension is enforced through the widened is_active_user() — a suspended hauler can't bid, a
-- suspended customer can't post, and both effects trace back to the one function nearly every
-- write path already calls, with zero edits to bids_insert/jobs_insert_own themselves beyond the
-- new posting/bidding-restricted clauses added in this same migration.
begin;
select plan(5);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
-- require_aal2() reads auth.jwt()->>'aal', which only ever resolves from the whole
-- request.jwt.claims JSON blob (auth.uid() has its own separate request.jwt.claim.sub fast path,
-- set alongside it above) — admin_suspend_user calls require_aal2(), so this step-up claim has to
-- be present for it to pass under pgTAP the same way a live aal2-verified admin session would.
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
set local role authenticated;
select lives_ok(
  $$ select admin_suspend_user('22222222-2222-2222-2222-222222222222', 'fraud_abuse') $$,
  'a full admin can suspend a hauler'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;
select is(
  (select is_active_user()), false,
  'is_active_user() is false for a suspended hauler'
);
select throws_ok(
  $$ insert into bids (job_id, hauler_id, amount) values ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222', 42) $$,
  '42501', 'new row violates row-level security policy for table "bids"',
  'a suspended hauler cannot place a bid'
);

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
-- require_aal2() reads auth.jwt()->>'aal', which only ever resolves from the whole
-- request.jwt.claims JSON blob (auth.uid() has its own separate request.jwt.claim.sub fast path,
-- set alongside it above) — admin_suspend_user calls require_aal2(), so this step-up claim has to
-- be present for it to pass under pgTAP the same way a live aal2-verified admin session would.
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
set local role authenticated;
select lives_ok(
  $$ select admin_suspend_user('33333333-3333-3333-3333-333333333333', 'fraud_abuse') $$,
  'a full admin can suspend a customer'
);

reset role;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;
select throws_ok(
  $$ insert into jobs (customer_id, title, zip, payment_mode) values ('33333333-3333-3333-3333-333333333333', 'should not post', '60629', 'deposit') $$,
  '42501', 'new row violates row-level security policy for table "jobs"',
  'a suspended customer cannot post a job'
);

select * from finish();
rollback;
