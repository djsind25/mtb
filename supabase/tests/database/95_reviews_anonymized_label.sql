-- reviews has no user_id at all (chat_id, reviewer_role only) — anonymization needs zero changes
-- to the table itself; only the profiles row it's joined against for display changes.
begin;
select plan(3);

insert into jobs (id, customer_id, title, zip, payment_mode)
values ('95000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'pgTAP review-label job', '60629', 'deposit');
select set_config('app.bypass_job_guard', 'true', true);
update jobs set status = 'booked', completed = true, completed_at = now()
  where id = '95000000-0000-0000-0000-000000000001';

insert into chats (id, job_id, customer_id, hauler_id, bid_amount, deposit, balance_due, commission, payment_mode, commission_status)
values ('95000000-0000-0000-0000-000000000002', '95000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 90, 9, 0, 9, 'deposit', 'earned');

insert into reviews (chat_id, reviewer_role, rating, text)
values ('95000000-0000-0000-0000-000000000002', 'hauler', 4, 'Fine to work with.');

select anonymize_account('33333333-3333-3333-3333-333333333333');

select isnt_empty(
  $$ select 1 from reviews where chat_id = '95000000-0000-0000-0000-000000000002' and reviewer_role = 'hauler' $$,
  'the review row still exists after the customer is anonymized'
);
select is(
  (select p.name from chats c join profiles p on p.id = c.customer_id where c.id = '95000000-0000-0000-0000-000000000002'),
  'Deleted Customer',
  'the review''s joined display name now reads the anonymized placeholder'
);
select is(
  (select rating from reviews where chat_id = '95000000-0000-0000-0000-000000000002' and reviewer_role = 'hauler'),
  4,
  'the review''s own rating/text are untouched'
);

select * from finish();
rollback;
