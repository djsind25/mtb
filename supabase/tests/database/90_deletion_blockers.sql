-- check_account_deletion_blockers() is the one function both self-service and admin flows use.
-- Covers: active job, accepted-incomplete bid, pending payment (also covers "pending payout" for
-- a hauler, aliased to the same check per the confirmed design decision), and open dispute (via a
-- pending cancellation_requests row) all block deletion — plus IDOR prevention and the admin
-- bypass. Uses fresh throwaway jobs/bids scoped to this file (rolled back after), on top of the
-- persisted 00_setup.sql fixtures (chat 77777777... already defaults commission_status='held',
-- giving customer 111...1 and hauler 222...2 a pending-payment blocker with no extra setup).
begin;
select plan(9);

-- ── Fresh fixture data (as the unrestricted setup role, before any impersonation below) ──

-- active_job: an open job for the "other customer" fixture.
insert into jobs (id, customer_id, title, zip, payment_mode)
values ('90000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'pgTAP active job', '60629', 'deposit');
select set_config('app.bypass_job_guard', 'true', true);
update jobs set status = 'open', completed = false, expires_at = now() + interval '10 days'
  where id = '90000000-0000-0000-0000-000000000001';

-- accepted_bid_incomplete: a booked-not-completed job whose accepted bid belongs to hauler 222.
insert into jobs (id, customer_id, title, zip, payment_mode)
values ('90000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'pgTAP accepted-bid job', '60629', 'deposit');
insert into bids (id, job_id, hauler_id, amount)
values ('90000000-0000-0000-0000-000000000003', '90000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 75);
select set_config('app.bypass_job_guard', 'true', true);
update jobs set status = 'booked', completed = false, accepted_bid_id = '90000000-0000-0000-0000-000000000003'
  where id = '90000000-0000-0000-0000-000000000002';

-- open_dispute: a pending cancellation request against the shared fixture job/chat.
insert into cancellation_requests (job_id, chat_id, requested_by, requested_role, reason)
values ('66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777',
  '11111111-1111-1111-1111-111111111111', 'customer', 'pgTAP dispute test');

select isnt_empty(
  $$ select 1 from check_account_deletion_blockers('33333333-3333-3333-3333-333333333333') where blocker_type = 'active_job' $$,
  'an open job is surfaced as an active_job blocker'
);
select isnt_empty(
  $$ select 1 from check_account_deletion_blockers('22222222-2222-2222-2222-222222222222') where blocker_type = 'accepted_bid_incomplete' $$,
  'an accepted-but-incomplete bid is surfaced as a blocker for the hauler'
);
select isnt_empty(
  $$ select 1 from check_account_deletion_blockers('11111111-1111-1111-1111-111111111111') where blocker_type = 'pending_payment' $$,
  'held commission is surfaced as a pending_payment blocker for the customer'
);
select isnt_empty(
  $$ select 1 from check_account_deletion_blockers('22222222-2222-2222-2222-222222222222') where blocker_type = 'pending_payment' $$,
  'held commission is surfaced as a pending_payment blocker for the hauler (aliases pending_payout)'
);
select isnt_empty(
  $$ select 1 from check_account_deletion_blockers('11111111-1111-1111-1111-111111111111') where blocker_type = 'open_dispute' $$,
  'a pending cancellation request is surfaced as an open_dispute blocker'
);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
select throws_ok(
  $$ select request_own_account_deletion('leaving') $$,
  'P0001', 'ACCOUNT_DELETION_BLOCKED: Your account can''t be deleted yet — resolve the items listed and try again.',
  'a customer with open blockers cannot request deletion'
);
select throws_ok(
  $$ select check_account_deletion_blockers('22222222-2222-2222-2222-222222222222') $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Not authorized to check this account.',
  'a non-admin cannot check another user''s blockers (IDOR prevention)'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;
select throws_ok(
  $$ select request_own_account_deletion('leaving') $$,
  'P0001', 'ACCOUNT_DELETION_BLOCKED: Your account can''t be deleted yet — resolve the items listed and try again.',
  'a hauler with open blockers cannot request deletion'
);

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;
select lives_ok(
  $$ select 1 from check_account_deletion_blockers('11111111-1111-1111-1111-111111111111') limit 1 $$,
  'a full admin can check any account''s blockers'
);

select * from finish();
rollback;
