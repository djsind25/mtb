-- Resolving/reopening a support request is append-only, same convention as this codebase's
-- cancellation_requests/bid_revisions — reopening inserts a fresh pending row rather than
-- mutating the resolved one back, so the original resolution's history is never lost.
begin;
select plan(7);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;
select request_chat_support('66666666-6666-6666-6666-666666666666', 'first issue');

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select lives_ok(
  $$ select admin_resolve_support((select id from support_requests where chat_id = '77777777-7777-7777-7777-777777777777' and status = 'pending'), 'sorted it out') $$,
  'a full admin can resolve the pending request'
);

select is(
  (select support_status from chats where id = '77777777-7777-7777-7777-777777777777'),
  'resolved',
  'resolving flips support_status to resolved'
);

select isnt_empty(
  $$ select 1 from support_requests where chat_id = '77777777-7777-7777-7777-777777777777' and status = 'resolved' and resolved_by = '44444444-4444-4444-4444-444444444444' and resolved_at is not null $$,
  'the resolved request keeps its resolver and timestamp'
);

select lives_ok(
  $$ select admin_reopen_support('77777777-7777-7777-7777-777777777777', 'customer wrote back') $$,
  'a full admin can reopen support for this conversation'
);

select is(
  (select count(*)::int from support_requests where chat_id = '77777777-7777-7777-7777-777777777777'),
  2,
  'reopening inserts a new row rather than mutating the resolved one (append-only)'
);

select isnt_empty(
  $$ select 1 from support_requests where chat_id = '77777777-7777-7777-7777-777777777777' and status = 'resolved' and resolved_at is not null $$,
  'the original resolved row is still intact after reopening'
);

reset role;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
set local role authenticated;

select throws_ok(
  $$ select admin_resolve_support((select id from support_requests where chat_id = '77777777-7777-7777-7777-777777777777' and status = 'pending')) $$,
  'P0001', 'Only full admins can resolve a support request',
  'a view-only admin cannot resolve a support request'
);

select * from finish();
rollback;
