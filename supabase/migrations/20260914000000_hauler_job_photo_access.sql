-- job_photos_select (and its storage counterpart) only ever granted a hauler visibility while
-- job_is_open_for_bid(job_id) is true — the job's own posting hasn't expired, isn't flagged, and
-- is still 'open'. That's too narrow in two real ways, both reported live:
--
--   1. A job's own posting expiry and a hauler's *bid* expiry are two separate clocks (see the
--      comment on the Q&A toggle in HaulerBidStatusCard.jsx) — a bid can still be genuinely
--      pending, awaiting the customer's decision, days after the job's own 14-day posting window
--      has lapsed. That hauler could no longer see the job's required photo at all.
--   2. Once a bid is accepted, jobs.status moves off 'open' for good — so the *winning* hauler
--      permanently lost access to the job's own posting photos the moment they won, including
--      after completion. job_photos_storage_select was already patched for this in
--      20260905020000_medium_findings_backend.sql (M-5) via hauler_owns_chat_job(), but the base
--      table policy (job_photos_select) — which loadJobPhotos() actually selects from first —
--      was never brought in line, so the storage fix was silently unreachable: zero rows back
--      from the table query means createSignedUrl() never even gets called.
--
-- Fix: a hauler who has ever placed a bid on the job (pending, won, or lost) can see its photos,
-- in addition to the existing "any eligible hauler while still open" case needed for Browse Jobs
-- previews. hauler_owns_chat_job() is a strict subset of this (no chat exists without a prior
-- bid), so this one function covers both gaps above without needing a second clause.
-- hauler_bid_on_job() already exists (init_schema.sql) — same helper jobs_select and
-- get_or_create_job_support_chat() already trust for exactly this "any hauler who ever bid, not
-- just the winner" semantics — reused here as-is, not redefined.

alter policy job_photos_select on job_photos using (
  customer_owns_job(job_photos.job_id) or job_is_open_for_bid(job_photos.job_id)
  or hauler_bid_on_job(job_photos.job_id)
  or (is_admin() and job_in_admin_territory(job_photos.job_id))
);

DROP POLICY IF EXISTS "job_photos_storage_select" ON "storage"."objects";
CREATE POLICY "job_photos_storage_select" ON "storage"."objects" FOR SELECT
  USING (
    (bucket_id = 'job-photos'::text) AND (
      is_admin()
      OR customer_owns_job(((storage.foldername(name))[1])::uuid)
      OR hauler_bid_on_job(((storage.foldername(name))[1])::uuid)
      OR (
        job_is_open_for_bid(((storage.foldername(name))[1])::uuid)
        AND hauler_eligible_for_job_photos(((storage.foldername(name))[1])::uuid)
      )
    )
  );
