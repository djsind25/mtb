-- Staff-only notes are the one piece of content that must NEVER reach a customer or hauler under
-- any circumstance, per the product requirement that admin participation stay transparent while
-- staff notes stay private. A full admin can add one without having joined the conversation first
-- (see messages_insert's RLS policy) — joining only gates participants-visible admin sends.
begin;
select plan(4);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select lives_ok(
  $$ insert into messages (chat_id, sender_role, sender_id, visibility, text) values ('77777777-7777-7777-7777-777777777777', 'admin', '44444444-4444-4444-4444-444444444444', 'staff_only', 'internal note: keep an eye on this one') $$,
  'a full admin can insert a staff-only note without having joined'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select is_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and visibility = 'staff_only' $$,
  'the customer never sees the staff-only note'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select is_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and visibility = 'staff_only' $$,
  'the hauler never sees the staff-only note'
);

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select isnt_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and visibility = 'staff_only' $$,
  'the admin who wrote it can see the staff-only note'
);

select * from finish();
rollback;
