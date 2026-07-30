-- The one centralized anonymize_account() function: replaces identity fields with placeholders,
-- leaves completed jobs/payments/reviews byte-for-byte intact (profiles.id never changes, so every
-- FK relationship survives), and is safe to call a second time (idempotency guarantee).
begin;
select plan(6);

insert into jobs (id, customer_id, title, zip, payment_mode)
values ('94000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'pgTAP completed job', '60629', 'deposit');
select set_config('app.bypass_job_guard', 'true', true);
update jobs set status = 'booked', completed = true, completed_at = now()
  where id = '94000000-0000-0000-0000-000000000001';

-- commission_status explicitly 'earned' (not the table default 'held') so this fixture carries no
-- pending-payment blocker of its own — this file is testing anonymization, not blocker-gating.
insert into chats (id, job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode, commission_status)
values ('94000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 200, 20, 0, 20, 'deposit', 'earned');

insert into payments (id, job_id, chat_id, amount, status, kind)
values ('94000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000002', 180, 'succeeded', 'charge');

insert into reviews (chat_id, reviewer_role, rating, text)
values ('94000000-0000-0000-0000-000000000002', 'hauler', 5, 'Great customer, paid promptly.');

select set_config('app.bypass_profile_guard', 'true', true);
update profiles set status = 'deletion_requested', deletion_requested_at = now() - interval '31 days',
  deletion_scheduled_for = now() - interval '1 day'
  where id = '33333333-3333-3333-3333-333333333333';

select set_config('request.jwt.claim.sub', '44444444-4444-4444-4444-444444444444', true);
select set_config('request.jwt.claims', '{"aal":"aal2"}', true);
set local role authenticated;

select lives_ok(
  $$ select admin_anonymize_now('33333333-3333-3333-3333-333333333333', 'compliance test') $$,
  'a full admin can anonymize a due, unblocked account'
);
select is(
  (select name from profiles where id = '33333333-3333-3333-3333-333333333333'),
  'Deleted Customer',
  'the name is replaced with the customer placeholder'
);
select ok(
  (select email like 'deleted-user-%@deleted.mytrashbid.invalid' from profiles where id = '33333333-3333-3333-3333-333333333333'),
  'the email is replaced with a non-deliverable internal placeholder'
);
select is(
  (select amount from payments where id = '94000000-0000-0000-0000-000000000003'),
  180.00,
  'the completed job''s payment amount is untouched'
);
select is(
  (select rating from reviews where chat_id = '94000000-0000-0000-0000-000000000002' and reviewer_role = 'hauler'),
  5,
  'the review rating is untouched'
);

reset role;
select lives_ok(
  $$ select anonymize_account('33333333-3333-3333-3333-333333333333') $$,
  'calling anonymize_account a second time on an already-anonymized account is a safe no-op'
);

select * from finish();
rollback;
