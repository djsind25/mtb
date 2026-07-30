-- The job's customer/hauler can read and post participants-visible messages on their own chat;
-- an unrelated third party can do neither; a view-only admin can read (is_admin()) but this file
-- doesn't test writes for them — that's covered by the is_full_admin()-gated RPCs in later files.
begin;
select plan(6);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'customer', '11111111-1111-1111-1111-111111111111', 'hello from customer') $$,
  'the job''s customer can insert a participants-visible message'
);

select isnt_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and text = 'hello from customer' $$,
  'the customer can select their own message back'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select lives_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'hauler', '22222222-2222-2222-2222-222222222222', 'hello from hauler') $$,
  'the assigned hauler can insert a participants-visible message'
);

reset role;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
set local role authenticated;

select is_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' $$,
  'an unrelated third party sees no messages in this chat'
);

select throws_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, text) values ('77777777-7777-7777-7777-777777777777', 'customer', '33333333-3333-3333-3333-333333333333', 'sneaky') $$,
  '42501', 'new row violates row-level security policy for table "messages"',
  'an unrelated third party cannot insert a message into this chat'
);

reset role;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
set local role authenticated;

select isnt_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' $$,
  'a view-only admin can view every message in the chat'
);

select * from finish();
rollback;
