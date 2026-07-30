-- Joining is what makes admin participation visible (system message + support_status flip) and is
-- the precondition for sending a participants-visible message; only is_full_admin() can join —
-- a view-only admin can view the chat but never join/act on it.
begin;
select plan(6);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select lives_ok(
  $$ select admin_join_chat('77777777-7777-7777-7777-777777777777') $$,
  'a full admin can join the conversation'
);

select isnt_empty(
  $$ select 1 from chat_admin_sessions where chat_id = '77777777-7777-7777-7777-777777777777' and admin_id = '44444444-4444-4444-4444-444444444444' and left_at is null $$,
  'joining creates an open chat_admin_sessions row'
);

select isnt_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and sender_role = 'system' and text like '%joined this conversation%' $$,
  'joining posts a visible system message'
);

select is(
  (select support_status from chats where id = '77777777-7777-7777-7777-777777777777'),
  'active',
  'joining flips support_status to active'
);

select throws_ok(
  $$ select admin_join_chat('77777777-7777-7777-7777-777777777777') $$,
  'P0001', 'You have already joined this conversation',
  'joining a conversation twice as the same admin raises'
);

reset role;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
set local role authenticated;

select throws_ok(
  $$ select admin_join_chat('77777777-7777-7777-7777-777777777777') $$,
  'P0001', 'Only full admins can join a conversation',
  'a view-only admin cannot join a conversation'
);

select * from finish();
rollback;
