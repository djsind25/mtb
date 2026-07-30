-- "Never in participant API responses" reduces to "never selectable under RLS as that party" —
-- Realtime's postgres_changes payloads are generated through the same messages_select policy, so
-- proving the row is unreachable by select (even by an attacker who already knows its exact text)
-- covers the API, direct-query, and realtime-delivery cases in one shot.
begin;
select plan(3);

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;
select admin_join_chat('77777777-7777-7777-7777-777777777777');
insert into messages (chat_id, sender_role, sender_id, visibility, text)
values ('77777777-7777-7777-7777-777777777777', 'admin', '44444444-4444-4444-4444-444444444444', 'staff_only', 'do-not-leak-marker-70');

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select is_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and text = 'do-not-leak-marker-70' $$,
  'the customer cannot find the staff-only message even when querying by its exact text'
);

select is(
  (select count(*)::int from messages where chat_id = '77777777-7777-7777-7777-777777777777'),
  (select count(*)::int from messages where chat_id = '77777777-7777-7777-7777-777777777777' and visibility = 'participants'),
  'every message visible to the customer is participants-visible — nothing staff-only slipped through'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select is_empty(
  $$ select 1 from messages where chat_id = '77777777-7777-7777-7777-777777777777' and text = 'do-not-leak-marker-70' $$,
  'the hauler cannot find the staff-only message either'
);

select * from finish();
rollback;
