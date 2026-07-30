-- "Vanish from search" for a hauler with no directory to vanish from: a non-active-status
-- hauler's still-pending bid disappears from the customer's own bid list (bids_select), while the
-- hauler still sees their own bid, and an already-accepted bid survives regardless of the
-- hauler's later status (in-flight job history is preserved). New bids are also blocked outright.
begin;
select plan(5);

insert into jobs (id, customer_id, title, zip, payment_mode)
values ('92000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'pgTAP search-visibility job', '60629', 'deposit');
select set_config('app.bypass_job_guard', 'true', true);
update jobs set status = 'open', completed = false, expires_at = now() + interval '10 days'
  where id = '92000000-0000-0000-0000-000000000001';
insert into bids (id, job_id, hauler_id, amount)
values ('92000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 60);

select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;
select isnt_empty(
  $$ select 1 from bids where id = '92000000-0000-0000-0000-000000000002' $$,
  'the customer sees the hauler''s pending bid while the hauler is active'
);

reset role;
select set_config('app.bypass_profile_guard', 'true', true);
update profiles set status = 'deletion_requested', deletion_requested_at = now(), deletion_scheduled_for = now() + interval '30 days'
  where id = '22222222-2222-2222-2222-222222222222';

select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;
select is_empty(
  $$ select 1 from bids where id = '92000000-0000-0000-0000-000000000002' $$,
  'the pending bid disappears from the customer''s view once the hauler is deletion_requested'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;
select isnt_empty(
  $$ select 1 from bids where id = '92000000-0000-0000-0000-000000000002' $$,
  'the hauler still sees their own bid regardless of status'
);
select throws_ok(
  $$ insert into bids (job_id, hauler_id, amount) values ('66666666-6666-6666-6666-666666666666', '22222222-2222-2222-2222-222222222222', 15) $$,
  '42501', 'new row violates row-level security policy for table "bids"',
  'the deletion_requested hauler cannot place a new bid'
);

reset role;
select set_config('app.bypass_job_guard', 'true', true);
update jobs set accepted_bid_id = '92000000-0000-0000-0000-000000000002' where id = '92000000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;
select isnt_empty(
  $$ select 1 from bids where id = '92000000-0000-0000-0000-000000000002' $$,
  'the now-accepted bid stays visible to the customer despite the hauler''s non-active status'
);

select * from finish();
rollback;
