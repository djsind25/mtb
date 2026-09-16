-- "Description is required to post a job" was only ever true in the landing page's own form
-- (site/index.html's qcDescError check) -- PostJobForm.jsx's canSubmit gate never checked it, so
-- a job posted from the main app could go out with an empty description, and nothing server-side
-- ever caught it either (a raw insert bypassing both forms would sail through). Fixed client-side
-- in PostJobForm.jsx's canSubmit; this closes it server-side too, the same reasoning as
-- 20260918000000_enforce_job_photo_requirement.sql for photos -- except description lives
-- directly on the jobs row itself (unlike photos, a separate table inserted afterward), so a
-- straightforward CHECK constraint is enough; no chokepoint-widening needed.
--
-- Rentals are exempt -- selectCategory's rental branch has no description field at all (the
-- dumpster type + dates + timeline already say everything a hauler needs), matching the same
-- exemption the photo requirement already carved out for rentals.
--
-- Verified zero existing violations before adding this: no removal-type job in production has a
-- null/empty description today.

alter table jobs add constraint jobs_description_required_check
  check (service_type = 'rental' or (description is not null and trim(description) <> ''));
