-- guard_chat_self_update() must block a customer/hauler from directly writing the new
-- admin-moderation columns despite chats_update_own otherwise permitting the UPDATE — every
-- legitimate write to these columns goes through the RPCs above, which set
-- app.bypass_chat_guard first. The last check proves the guard is selective, not blanket: a
-- pre-existing self-editable column (hauler_last_read_at) still works.
begin;
select plan(4);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select throws_ok(
  $$ update chats set support_status = 'resolved' where id = '77777777-7777-7777-7777-777777777777' $$,
  'P0001', 'Not permitted to change this field.',
  'a customer cannot directly set support_status despite chats_update_own otherwise permitting the UPDATE'
);

select throws_ok(
  $$ update chats set admin_locked_at = now() where id = '77777777-7777-7777-7777-777777777777' $$,
  'P0001', 'Not permitted to change this field.',
  'a customer cannot directly set admin_locked_at'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select throws_ok(
  $$ update chats set assigned_admin_id = '22222222-2222-2222-2222-222222222222' where id = '77777777-7777-7777-7777-777777777777' $$,
  'P0001', 'Not permitted to change this field.',
  'a hauler cannot directly set assigned_admin_id'
);

select lives_ok(
  $$ update chats set hauler_last_read_at = now() where id = '77777777-7777-7777-7777-777777777777' $$,
  'the guard is selective — a hauler can still update their own last-read timestamp'
);

select * from finish();
rollback;
