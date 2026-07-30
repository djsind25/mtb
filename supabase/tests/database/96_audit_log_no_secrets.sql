-- The audit log is admin-only readable and never carries a password/AAL/token — this asserts both
-- the visibility boundary and the absence of anything secret-shaped in the rows this suite itself
-- generated.
begin;
select plan(4);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
set local role authenticated;
select lives_ok(
  $$ select admin_suspend_user('33333333-3333-3333-3333-333333333333', 'testing audit reason with agent') $$,
  'suspending generates an audit row'
);

select is_empty(
  $$ select 1 from account_lifecycle_audit_log
     where reason ilike '%password%' or reason ilike '%aal%' or reason ilike '%token%' or reason ilike '%code%'
        or user_agent ilike '%password%' or user_agent ilike '%aal%' or user_agent ilike '%token%' or user_agent ilike '%code%' $$,
  'no audit row contains a password, AAL, token, or code substring'
);
select isnt_empty(
  $$ select 1 from account_lifecycle_audit_log where target_user_id = '33333333-3333-3333-3333-333333333333' $$,
  'a full admin can read the audit log'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
select is_empty(
  $$ select 1 from account_lifecycle_audit_log $$,
  'a non-admin cannot read any row of the audit log'
);

select * from finish();
rollback;
