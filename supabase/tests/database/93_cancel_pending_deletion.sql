-- Self-service cancel during the 30-day recovery window round-trips deletion_requested -> active,
-- and a second cancel attempt on an already-active account is rejected.
begin;
select plan(5);

select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;

select lives_ok(
  $$ select request_own_account_deletion('moving on') $$,
  'a customer with no blockers can request deletion'
);
select is(
  (select status from profiles where id = '33333333-3333-3333-3333-333333333333'),
  'deletion_requested',
  'the account status flips to deletion_requested'
);
select lives_ok(
  $$ select cancel_own_pending_deletion() $$,
  'the same customer can cancel the pending deletion'
);
select is(
  (select status from profiles where id = '33333333-3333-3333-3333-333333333333'),
  'active',
  'cancelling restores the account to active'
);
select throws_ok(
  $$ select cancel_own_pending_deletion() $$,
  'P0001', 'There is no pending deletion request on this account.',
  'cancelling again with nothing pending is rejected'
);

select * from finish();
rollback;
