-- The customer/hauler-facing "Request support" action: fans out to every admin (including
-- view-only ones, for visibility), flips support_status, and rejects a second request while one
-- is still pending — same dedup shape as this codebase's existing cancellation_requests.
begin;
select plan(6);

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$ select request_chat_support('66666666-6666-6666-6666-666666666666', 'need help with a billing question') $$,
  'the customer can request support'
);

select is(
  (select support_status from chats where id = '77777777-7777-7777-7777-777777777777'),
  'requested',
  'requesting support flips support_status to requested'
);

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;

select isnt_empty(
  $$ select 1 from notifications where user_id = '44444444-4444-4444-4444-444444444444' and event_type = 'supportRequested' $$,
  'the full admin is notified of the new support request'
);

reset role;
select set_config('request.jwt.claim.sub', '55555555-5555-5555-5555-555555555555', true);
set local role authenticated;

select isnt_empty(
  $$ select 1 from notifications where user_id = '55555555-5555-5555-5555-555555555555' and event_type = 'supportRequested' $$,
  'the view-only admin is also notified'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
set local role authenticated;

select throws_ok(
  $$ select request_chat_support('66666666-6666-6666-6666-666666666666') $$,
  'P0001', 'Support has already been requested for this conversation',
  'a second request while one is already pending is rejected'
);

reset role;
select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
set local role authenticated;
select admin_resolve_support((select id from support_requests where chat_id = '77777777-7777-7777-7777-777777777777' and status = 'pending'));

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
set local role authenticated;

select lives_ok(
  $$ select request_chat_support('66666666-6666-6666-6666-666666666666') $$,
  'a new request can be made after the previous one was resolved'
);

select * from finish();
rollback;
