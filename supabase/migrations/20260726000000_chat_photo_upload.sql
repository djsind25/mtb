-- Lets the customer add more photos to a job's existing Photo Album from within the chat (e.g.
-- the hauler asks to see something more closely before finalizing). The upload/message side is
-- pure client code (job_photos_insert already allows the owning customer to insert regardless of
-- job status, no RPC needed) — the one real gap this surfaced is on the read side.
--
-- job_photos_select only ever granted read access to the job's own customer, ANY hauler while
-- the job is still open for bid, or an admin — there was no clause for the hauler who's actually
-- been accepted once the job books. That's not new: it means the *original* job-post photos were
-- already invisible to the winning hauler after booking, this feature just surfaced it by giving
-- the hauler's "My Bids" card a reason to render the album at all. hauler_owns_chat_job(job_id)
-- (scoped to the live, non-superseded chat as of the code-review fixes) is exactly "is this
-- caller the currently-assigned hauler for this job" — reuse it here instead of inventing another
-- ownership check.
drop policy job_photos_select on job_photos;
create policy job_photos_select on job_photos for select
  using (customer_owns_job(job_id) or job_is_open_for_bid(job_id) or hauler_owns_chat_job(job_id) or is_admin());

-- Same gap, same fix, for the storage bucket backing those rows — without this the REST rows
-- would be readable but createSignedUrl() would still 400 for the assigned hauler.
drop policy job_photos_storage_select on storage.objects;
create policy job_photos_storage_select on storage.objects for select
  using (
    bucket_id = 'job-photos'
    and (
      customer_owns_job(((storage.foldername(name))[1])::uuid)
      or job_is_open_for_bid(((storage.foldername(name))[1])::uuid)
      or hauler_owns_chat_job(((storage.foldername(name))[1])::uuid)
      or is_admin()
    )
  );
