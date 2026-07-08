-- MyTrashBid — dumpster/trailer rental marketplace + hauler rating aggregation
--
-- Adds a second service type ("rental") alongside the existing junk-removal jobs. A rental is
-- just a `jobs` row with service_type='rental' and dumpster_type/rental dates instead of a
-- description — every other mechanic (bids, accept_bid, chats, payments, confirm_job_complete,
-- reviews, renew_job/renew_bid) already operates on `jobs` generically and needs no changes.
--
-- Also fixes a real gap: `profiles.rating` has existed since the initial schema but nothing ever
-- populated it, so customers had no way to see a hauler's review history when picking a bid —
-- something the rental flow explicitly requires ("haulers... see reviews and price").

-- ─── Rental fields on jobs ──────────────────────────────────────────────────────
alter table jobs
  add column service_type text not null default 'removal' check (service_type in ('removal', 'rental')),
  add column dumpster_type text check (dumpster_type in ('trailer', 'rolloff')),
  add column rental_start_date date,
  add column rental_end_date date;

-- Rentals stay live for 30 days (vs. 14 for removal jobs) per spec.
insert into app_config (key, value) values ('rental_live_window_days', '30')
  on conflict (key) do nothing;

create or replace function set_job_expiry() returns trigger
  language plpgsql as $$
  declare
    v_days int;
  begin
    v_days := case when new.service_type = 'rental'
      then app_config_numeric('rental_live_window_days')::int
      else app_config_numeric('live_window_days')::int
    end;
    new.expires_at := new.created_at + make_interval(days => v_days);
    if new.zip is not null then
      select lat, lng into new.lat, new.lng from zip_geo where zip = trim(new.zip);
    end if;
    return new;
  end;
  $$;

-- Postgres won't let CREATE OR REPLACE change a function's output columns, so this one needs a
-- real drop-and-recreate to add the rental fields to what haulers see when browsing.
drop function if exists list_open_jobs_for_hauler();

create function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date,
  created_at timestamptz, expires_at timestamptz, bid_count bigint, distance_mi numeric, photo_count bigint
)
language plpgsql security definer set search_path = public as $$
declare
  v_hauler profiles%rowtype;
  v_radius numeric;
begin
  select * into v_hauler from profiles where profiles.id = auth.uid();
  if v_hauler.id is null or v_hauler.role <> 'hauler' then
    raise exception 'Only hauler accounts can browse open jobs';
  end if;
  if not v_hauler.active then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  v_radius := app_config_numeric('max_radius_mi');

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode,
      j.service_type, j.dumpster_type, j.rental_start_date, j.rental_end_date,
      j.created_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count
    from jobs j
    where j.status = 'open' and j.expires_at > now()
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;

grant execute on function list_open_jobs_for_hauler() to authenticated;

-- ─── Hauler rating aggregation ─────────────────────────────────────────────────
alter table profiles add column rating_count int not null default 0;

-- A hauler's public rating is the average of every review left about them by a customer
-- (reviewer_role='customer' on a chat where they were the hauler). Recomputed on every
-- insert/update so editing a review (already supported by the UI) keeps the aggregate correct.
create function update_hauler_rating() returns trigger
  language plpgsql security definer set search_path = public as $$
  declare
    v_hauler_id uuid;
    v_avg numeric;
    v_count int;
  begin
    if new.reviewer_role <> 'customer' then
      return new;
    end if;
    select hauler_id into v_hauler_id from chats where id = new.chat_id;
    if v_hauler_id is null then
      return new;
    end if;
    select avg(r.rating), count(*) into v_avg, v_count
      from reviews r join chats c on c.id = r.chat_id
      where c.hauler_id = v_hauler_id and r.reviewer_role = 'customer';
    update profiles set rating = round(v_avg, 2), rating_count = v_count where id = v_hauler_id;
    return new;
  end;
  $$;

create trigger reviews_update_hauler_rating after insert or update on reviews
  for each row execute function update_hauler_rating();

-- Expose the rating on the same public-safe view other users already read hauler info from.
create or replace view public_profiles as
  select id, role, name, business_name, avatar, verified, rating, rating_count
  from profiles;
