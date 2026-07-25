-- Seeds 36 varied open jobs (34 within a Homer Glen, IL hauler's 50-mile radius, 2 deliberately
-- outside it) for exercising the Find Jobs filters/sort/dismiss/saved-views feature at realistic
-- volume. Local dev only — creates throwaway fixture accounts directly in auth.users (they never
-- need to log in, only to exist as FK targets for jobs.customer_id / bids.hauler_id), plus a
-- spread of real bid rows so "Fewest bids" sort has texture.
--
-- Run against local Supabase:
--   docker exec -i supabase_db_MyTrashBid psql -U postgres -d postgres -f - < scripts/seed_find_jobs_test_data.sql
--
-- Safe to re-run: deletes its own prior output first (matched by the seed.* email prefix).
-- To test as a hauler, sign up for real with ZIP 60491 (or any ZIP near the ones below) — these
-- jobs need no changes to see; they show up in Find Jobs like any other open job.
-- Clean up when done:
--   docker exec -i supabase_db_MyTrashBid psql -U postgres -d postgres -c "delete from notifications where job_id in (select id from jobs where customer_id in (select id from profiles where email = 'seed.customer@mytrashbid.test')); delete from jobs where customer_id in (select id from profiles where email = 'seed.customer@mytrashbid.test'); delete from auth.users where email like 'seed.%@mytrashbid.test';"

-- jobs.customer_id/bids.hauler_id -> profiles(id), and notifications.job_id -> jobs(id), have no
-- ON DELETE CASCADE (unlike profiles(id) -> auth.users(id), which does) — deleting auth.users
-- first hits a foreign key violation on a re-run, and so does deleting jobs before notifications
-- (the new-job-nearby trigger fires on insert and leaves notification rows behind). Delete in FK
-- order: notifications, then jobs (which cascades their bids — bids.job_id -> jobs(id) IS
-- cascading), then the fixture accounts themselves.
delete from notifications where job_id in (select id from jobs where customer_id in (select id from profiles where email = 'seed.customer@mytrashbid.test'));
delete from jobs where customer_id in (select id from profiles where email = 'seed.customer@mytrashbid.test');
delete from auth.users where email like 'seed.%@mytrashbid.test';

-- ── Fixture accounts ────────────────────────────────────────────────────────────
-- One customer to own all 36 jobs, six haulers purely to author bids for count variety.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  email, crypt('seedpass123', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, meta, now(), now()
from (values
  ('seed.customer@mytrashbid.test', '{"role":"customer","name":"Seed Customer","zip":"60491"}'::jsonb),
  ('seed.filler1@mytrashbid.test', '{"role":"hauler","name":"Filler Hauling 1","business_name":"Filler Hauling 1","zip":"60491"}'::jsonb),
  ('seed.filler2@mytrashbid.test', '{"role":"hauler","name":"Filler Hauling 2","business_name":"Filler Hauling 2","zip":"60467"}'::jsonb),
  ('seed.filler3@mytrashbid.test', '{"role":"hauler","name":"Filler Hauling 3","business_name":"Filler Hauling 3","zip":"60441"}'::jsonb),
  ('seed.filler4@mytrashbid.test', '{"role":"hauler","name":"Filler Hauling 4","business_name":"Filler Hauling 4","zip":"60432"}'::jsonb),
  ('seed.filler5@mytrashbid.test', '{"role":"hauler","name":"Filler Hauling 5","business_name":"Filler Hauling 5","zip":"60451"}'::jsonb),
  ('seed.filler6@mytrashbid.test', '{"role":"hauler","name":"Filler Hauling 6","business_name":"Filler Hauling 6","zip":"60403"}'::jsonb)
) as t(email, meta);

-- handle_new_user() auto-inserted profiles rows off the trigger above. The jobs_set_expiry
-- trigger checks the *customer's* email_verified_at (not auth.users.email_confirmed_at) to decide
-- whether a posted job goes live — same distinction that tripped up an earlier session fixture.
update profiles set email_verified_at = now() where email = 'seed.customer@mytrashbid.test';

-- ── 36 jobs: 34 within 50mi of 60491, 2 deliberately beyond it ─────────────────
with customer as (select id from profiles where email = 'seed.customer@mytrashbid.test'),
jobs_v(zip, title, description, service_type, dumpster_type, timeline, created_offset_hours) as (values
  ('60467', 'Garage cleanout, old furniture + boxes',       'Couch, dresser, ~15 boxes. Garage access, no stairs.',              'removal', null,      'asap',         2),
  ('60448', 'Basement junk removal',                         'Old carpet, broken shelving, misc scrap wood.',                     'removal', null,      'this_week',    5),
  ('60441', 'Yard debris + fence removal',                   'Fallen branches and an old wood fence, ~40 linear ft.',             'removal', null,      'this_week',    9),
  ('60439', 'Roll-off dumpster, kitchen remodel',             null,                                                                'rental',  'rolloff', 'asap',          14),
  ('60462', 'Old mattress + box spring pickup',               'Queen mattress, box spring, curbside.',                             'removal', null,      'flexible',      20),
  ('60446', 'Estate cleanout, whole house',                   'Multiple rooms of furniture and belongings, 2nd floor.',           'removal', null,      'next_2_weeks',  26),
  ('60451', 'Trailer rental, landscaping debris',             null,                                                                'rental',  'trailer', 'this_week',     31),
  ('60432', 'Office furniture removal',                       'Desks, filing cabinets, chairs — 3rd floor, elevator available.',  'removal', null,      'this_month',    38),
  ('60487', 'Hot tub removal',                                'Non-working hot tub, backyard, needs 2+ people.',                  'removal', null,      'asap',          44),
  ('60440', 'Roll-off dumpster, roofing job',                 null,                                                                'rental',  'rolloff', 'this_week',     50),
  ('60477', 'Appliance removal, fridge + washer/dryer',       'Old fridge, washer, dryer — driveway pickup.',                     'removal', null,      'flexible',      57),
  ('60435', 'Construction debris cleanup',                    'Drywall scraps, lumber offcuts from a small reno.',                'removal', null,      'this_week',     63),
  ('60403', 'Trailer rental, moving leftovers',               null,                                                                'rental',  'trailer', 'next_2_weeks',  70),
  ('60490', 'Shed teardown debris',                           'Torn-down 8x10 shed, wood + shingles, curbside pile.',             'removal', null,      'this_month',    76),
  ('60423', 'Old couch + loveseat pickup',                    'Two pieces, front porch, easy access.',                            'removal', null,      'asap',          82),
  ('60406', 'Roll-off dumpster, garage cleanout',              null,                                                                'rental',  'rolloff', 'flexible',      89),
  ('60565', 'Electronics + e-waste removal',                  'Old TVs, computer towers, misc cables — garage.',                  'removal', null,      'this_week',     95),
  ('60544', 'Whole-apartment cleanout',                        'Studio apartment, tenant move-out, all contents.',                 'removal', null,      'next_2_weeks',  101),
  ('60585', 'Trailer rental, yard renovation',                null,                                                                'rental',  'trailer', 'this_month',    108),
  ('60404', 'Deck demolition debris',                          'Old wood deck boards + railing, backyard.',                        'removal', null,      'flexible',      114),
  ('60417', 'Old grill + patio furniture removal',            'Rusted grill, 4 patio chairs, glass table.',                       'removal', null,      'asap',          120),
  ('60466', 'Roll-off dumpster, basement finish',              null,                                                                'rental',  'rolloff', 'this_week',     127),
  ('60411', 'Storage unit cleanout',                          'Full 10x10 storage unit, mixed household items.',                  'removal', null,      'this_month',    133),
  ('60619', 'Old piano removal',                               'Upright piano, 2nd floor walk-up, no elevator.',                   'removal', null,      'next_2_weeks',  140),
  ('60606', 'Office cubicle removal',                          '6 cubicle sets, downtown office, loading dock access.',           'removal', null,      'flexible',      146),
  ('60621', 'Yard waste + brush pile',                         'Large brush pile from tree trimming, curbside.',                   'removal', null,      'this_week',     152),
  ('60304', 'Trailer rental, garage purge',                   null,                                                                'rental',  'trailer', 'asap',          159),
  ('60505', 'Old shed contents removal',                       'Lawn equipment, paint cans, misc clutter.',                        'removal', null,      'this_month',    165),
  ('60468', 'Roll-off dumpster, whole-home declutter',         null,                                                                'rental',  'rolloff', 'next_2_weeks',  171),
  ('60447', 'Broken exercise equipment pickup',                'Treadmill + weight bench, garage, heavy.',                         'removal', null,      'flexible',      178),
  ('60623', 'Renovation debris, small bathroom',               'Tile, drywall, old vanity — bagged and boxed.',                    'removal', null,      'this_week',     184),
  ('60165', 'Old bed frames + dressers, 3 bedrooms',           'Full move-out, 3 bedroom sets total.',                             'removal', null,      'next_2_weeks',  190),
  ('60190', 'Trailer rental, estate cleanout',                 null,                                                                'rental',  'trailer', 'this_month',    197),
  ('60714', 'Curbside junk pile, mixed household',             'Various bagged and loose items, easy street access.',             'removal', null,      'asap',          203),
  -- Deliberately outside the 50-mile radius — should never appear in Find Jobs regardless of filters.
  ('61371', 'Out-of-radius test job (should not appear)',      'This job is ~55mi away and must stay excluded.',                   'removal', null,      'asap',          10),
  ('60087', 'Out-of-radius test job (should not appear)',      'This job is ~55mi away and must stay excluded.',                   'removal', null,      'this_week',     15)
),
inserted as (
  insert into jobs (customer_id, title, description, zip, service_type, dumpster_type, timeline, created_at,
    rental_start_date, rental_end_date)
  select customer.id, jobs_v.title, jobs_v.description, jobs_v.zip, jobs_v.service_type, jobs_v.dumpster_type, jobs_v.timeline,
    now() - (jobs_v.created_offset_hours || ' hours')::interval,
    case when jobs_v.service_type = 'rental' then current_date + 7 end,
    case when jobs_v.service_type = 'rental' then current_date + 9 end
  from jobs_v, customer
  returning id, zip
)
-- ── Bid-count variety (0-6 bids per job, from the 6 filler haulers) — gives "Fewest bids" sort
-- something real to sort on instead of every job tying at zero. Each (job, filler hauler) pair is
-- independently coin-flipped — a plain WHERE filter on the cross join, so random() genuinely runs
-- once per row (a LIMIT-based "pick N of 6" inside a subquery gets hoisted and evaluated only
-- once total, producing the same N and the same haulers for every job — learned the hard way).
insert into bids (job_id, hauler_id, amount, note)
select inserted.id, filler.id, (120 + (random() * 380))::numeric(10,2), null
from inserted
cross join (select id from profiles where email like 'seed.filler%@mytrashbid.test') filler
where inserted.zip not in ('61371', '60087') -- no bids needed on the out-of-radius probes
  and random() < 0.55;
