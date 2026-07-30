-- Locking rejects customer/hauler sends but never admin sends (either visibility) — an admin has
-- to be able to keep working a locked conversation, and to unlock it, while it's locked.
begin;
select plan(8);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;
select admin_join_chat('77777777-7777-7777-7777-777777777777');

select lives_ok(
  $$ select admin_lock_chat('77777777-7777-7777-7777-777777777777', 'reviewing a dispute') $$,
  'a full admin can lock the conversation'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select throws_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'customer', '11111111-1111-1111-1111-111111111111', 'let me out') $$,
  '42501', 'new row violates row-level security policy for table "messages"',
  'a locked chat rejects a customer message'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select throws_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'hauler', '22222222-2222-2222-2222-222222222222', 'me too') $$,
  '42501', 'new row violates row-level security policy for table "messages"',
  'a locked chat rejects a hauler message'
);

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select lives_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'admin', '44444444-4444-4444-4444-444444444444', 'support update') $$,
  'an admin can still post a participants-visible message while locked'
);

select lives_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, visibility, text) values ('77777777-7777-7777-7777-777777777777', 'admin', '44444444-4444-4444-4444-444444444444', 'staff_only', 'internal note while locked') $$,
  'an admin can still post a staff note while locked'
);

select throws_ok(
  $$ select admin_lock_chat('77777777-7777-7777-7777-777777777777') $$,
  'P0001', 'This conversation is already locked',
  'locking an already-locked conversation raises'
);

select lives_ok(
  $$ select admin_unlock_chat('77777777-7777-7777-7777-777777777777') $$,
  'a full admin can unlock the conversation'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'customer', '11111111-1111-1111-1111-111111111111', 'good to send again') $$,
  'unlocking restores the customer''s ability to send messages'
);

select * from finish();
rollback;
