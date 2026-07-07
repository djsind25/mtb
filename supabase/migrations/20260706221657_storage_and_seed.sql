-- MyTrashBid — photo storage bucket + ZIP centroid seed data

-- ─── Storage: job photos ────────────────────────────────────────────────────────
-- Private bucket. Objects are stored as "{job_id}/{filename}" so policies can join back to
-- the jobs table the same way the job_photos row-level policies do.
insert into storage.buckets (id, name, public)
values ('job-photos', 'job-photos', false)
on conflict (id) do nothing;

-- storage.objects already ships with RLS enabled by the platform, and this migration role
-- doesn't own the table (supabase_storage_admin does) — so we only add policies here.

-- Uses the same customer_owns_job / job_is_open_for_bid SECURITY DEFINER helpers as the
-- job_photos table policies (see init_schema.sql) — a raw EXISTS subquery on jobs here would
-- apply jobs_select's own RLS to the subquery, which a hauler who hasn't bid yet can't pass.
create policy job_photos_storage_insert on storage.objects for insert
  with check (
    bucket_id = 'job-photos'
    and customer_owns_job(((storage.foldername(name))[1])::uuid)
  );

-- Readable by the job's owner, any hauler while the job is still open (bidding haulers need
-- to see the photos per Scope of Work 3.5), or admin.
create policy job_photos_storage_select on storage.objects for select
  using (
    bucket_id = 'job-photos'
    and (
      is_admin()
      or customer_owns_job(((storage.foldername(name))[1])::uuid)
      or job_is_open_for_bid(((storage.foldername(name))[1])::uuid)
    )
  );

create policy job_photos_storage_delete on storage.objects for delete
  using (
    bucket_id = 'job-photos'
    and customer_owns_job(((storage.foldername(name))[1])::uuid)
  );

-- ─── ZIP → lat/lng centroid seed data ───────────────────────────────────────────
-- Carried over verbatim from the prototype's embedded ZIP_GEO table (Will County, IL launch
-- market + surrounding ZIPs). To cover the whole country, bulk-import a full free ZIP centroid
-- dataset (US Census gazetteer or SimpleMaps) into this same table — no code changes needed,
-- the radius math in list_open_jobs_for_hauler() reads straight from zip_geo.
insert into zip_geo (zip, lat, lng, city, state) values
  ('60491', 41.609, -87.961, 'Homer Glen', 'IL'),
  ('60441', 41.589, -88.041, 'Lockport', 'IL'),
  ('60446', 41.626, -88.078, 'Romeoville', 'IL'),
  ('60439', 41.679, -87.987, 'Lemont', 'IL'),
  ('60462', 41.627, -87.857, 'Orland Park', 'IL'),
  ('60467', 41.600, -87.886, 'Orland Park', 'IL'),
  ('60448', 41.668, -87.939, 'Mokena', 'IL'),
  ('60417', 41.510, -87.671, 'Crete', 'IL'),
  ('60451', 41.516, -87.965, 'New Lenox', 'IL'),
  ('60432', 41.530, -88.069, 'Joliet', 'IL'),
  ('60435', 41.546, -88.122, 'Joliet', 'IL'),
  ('60403', 41.561, -88.133, 'Crest Hill', 'IL'),
  ('60404', 41.451, -88.198, 'Shorewood', 'IL'),
  ('60544', 41.604, -88.205, 'Plainfield', 'IL'),
  ('60564', 41.717, -88.201, 'Naperville', 'IL'),
  ('60565', 41.733, -88.133, 'Naperville', 'IL'),
  ('60585', 41.681, -88.234, 'Plainfield', 'IL'),
  ('60490', 41.703, -88.111, 'Bolingbrook', 'IL'),
  ('60440', 41.700, -88.068, 'Bolingbrook', 'IL'),
  ('60525', 41.789, -87.881, 'La Grange', 'IL'),
  ('60453', 41.717, -87.751, 'Oak Lawn', 'IL'),
  ('60477', 41.573, -87.794, 'Tinley Park', 'IL'),
  ('60487', 41.555, -87.823, 'Tinley Park', 'IL'),
  ('60406', 41.658, -87.737, 'Blue Island', 'IL'),
  ('60411', 41.508, -87.611, 'Chicago Heights', 'IL'),
  ('60466', 41.476, -87.692, 'Park Forest', 'IL'),
  ('60423', 41.481, -87.832, 'Frankfort', 'IL'),
  ('60619', 41.745, -87.605, 'Chicago', 'IL'),
  ('60606', 41.882, -87.638, 'Chicago', 'IL')
on conflict (zip) do nothing;
