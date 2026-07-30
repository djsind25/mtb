-- verified/license_active/insurance_active are now RPC-only, even for full admins — a plain direct
-- update (the old EditUserModal path) must be rejected, and the one legitimate override RPC must
-- require a reason, target only hauler accounts, and log to the same audit trail as everything
-- else in the account-lifecycle feature.
begin;
select plan(8);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
set local role authenticated;

select throws_ok(
  $$ update profiles set verified = true where id = '22222222-2222-2222-2222-222222222222' $$,
  'P0001', 'Not permitted to change this field.',
  'a direct write to verified is rejected even for a full admin'
);

select throws_ok(
  $$ select admin_set_hauler_verification_flag('22222222-2222-2222-2222-222222222222', 'verified', true, '') $$,
  'P0001', 'A reason is required.',
  'an empty reason is rejected'
);

select throws_ok(
  $$ select admin_set_hauler_verification_flag('22222222-2222-2222-2222-222222222222', 'bogus_field', true, 'testing') $$,
  'P0001', 'Invalid verification field.',
  'an unrecognized field name is rejected'
);

select throws_ok(
  $$ select admin_set_hauler_verification_flag('11111111-1111-1111-1111-111111111111', 'verified', true, 'testing') $$,
  'P0001', 'Only hauler accounts have a verification status.',
  'a customer account cannot be targeted'
);

select lives_ok(
  $$ select admin_set_hauler_verification_flag('22222222-2222-2222-2222-222222222222', 'verified', true, 'phone-verified per call on 7/30') $$,
  'a full admin can set the verified flag with a reason'
);

select is(
  (select verified from profiles where id = '22222222-2222-2222-2222-222222222222'),
  true,
  'the verified flag actually flipped'
);

select isnt_empty(
  $$ select 1 from account_lifecycle_audit_log
     where target_user_id = '22222222-2222-2222-2222-222222222222'
       and action = 'hauler_verification_flag_set'
       and reason = 'phone-verified per call on 7/30'
       and blockers_present @> '{"field": "verified", "new_value": true}'::jsonb $$,
  'the override is logged with the field name and new value'
);

reset role;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
set local role authenticated;

select throws_ok(
  $$ select admin_set_hauler_verification_flag('22222222-2222-2222-2222-222222222222', 'license_active', true, 'testing') $$,
  'P0001', 'INSUFFICIENT_ADMIN_PERMISSION: Only a full admin can change hauler verification status.',
  'a view-only admin cannot use the override'
);

select * from finish();
rollback;
