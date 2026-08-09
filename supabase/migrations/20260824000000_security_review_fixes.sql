-- MyTrashBid — fixes from the 2026-08-09 four-agent security/consistency review.
--
-- All four issues below are the same class of bug: a write path that was supposed to require
-- is_full_admin()/is_active_user() but didn't, either because it predates that helper or because
-- a later migration copied from a stale version. Byte-for-byte identical to the current live
-- definitions except for the one guard each is missing — no behavior change for anyone who was
-- already passing the intended check.

-- ─── 1. approve_profile_change_request / deny_profile_change_request — is_admin() -> is_full_admin() ───
-- Both were added in 20260730000000_membership_and_profile_locking.sql, after is_full_admin()
-- already existed (20260717010000_view_only_admin.sql), and never got the memo — every other
-- mutating admin RPC in the codebase gates on is_full_admin(). As written, a view-only admin could
-- approve/deny a hauler's requested business_name/license_number/insurance_info/
-- business_registration_number change (approve also resets verified=false on the 3
-- verification-relevant fields), which is exactly the write access admin_read_only is supposed to
-- remove.
create or replace function approve_profile_change_request(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req profile_change_requests%rowtype;
begin
  if not is_full_admin() then
    raise exception 'Only admins can approve profile change requests';
  end if;

  select * into v_req from profile_change_requests where id = p_request_id for update;
  if v_req.id is null then
    raise exception 'Change request not found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been resolved';
  end if;

  perform set_config('app.bypass_profile_guard', 'true', true);
  execute format('update profiles set %I = $1 where id = $2', v_req.field)
    using v_req.requested_value, v_req.hauler_id;

  if v_req.field in ('license_number', 'insurance_info', 'business_registration_number') then
    update profiles set verified = false where id = v_req.hauler_id;
  end if;

  update profile_change_requests set
    status = 'approved', resolved_at = now(), resolved_by = auth.uid(), admin_note = p_note
  where id = p_request_id;
end;
$$;

create or replace function deny_profile_change_request(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_full_admin() then
    raise exception 'Only admins can deny profile change requests';
  end if;
  update profile_change_requests set
    status = 'denied', resolved_at = now(), resolved_by = auth.uid(), admin_note = p_note
  where id = p_request_id and status = 'pending';
  if not found then
    raise exception 'This request is not pending';
  end if;
end;
$$;

-- ─── 2. job_questions_update RLS — is_admin() -> is_full_admin() ───
-- Added in 20260728000000_job_qna.sql (also after is_full_admin() already existed). The policy has
-- no column-level restriction on the admin branch (the app only ever sends {flag_reviewed}, but
-- RLS doesn't enforce that), so a view-only admin could flip flag_reviewed — or any other column —
-- on any job_questions row.
drop policy job_questions_update on job_questions;
create policy job_questions_update on job_questions for update
  using (is_full_admin() or (customer_owns_job(job_id) and is_active_user() and job_is_open_for_bid(job_id)))
  with check (is_full_admin() or (customer_owns_job(job_id) and is_active_user() and job_is_open_for_bid(job_id)));

-- ─── 3. list_open_jobs_for_hauler — restore the status='active' check ───
-- 20260815000000_account_deletion_and_suspension.sql correctly widened this to check both
-- v_hauler.active and v_hauler.status = 'active'. 20260823000000_timeline_specific_date.sql had to
-- drop and recreate this function to add timeline_date and copied from an earlier, stale version,
-- silently dropping the status check. A suspended or self-deletion-requested hauler (active=true,
-- status != 'active') could still browse every open job's title/description/ZIP/photos, even
-- though bids_insert correctly still blocks them from actually bidding.
create or replace function list_open_jobs_for_hauler()
returns table (
  id uuid, title text, description text, zip text, status text, payment_mode text,
  service_type text, dumpster_type text, rental_start_date date, rental_end_date date, timeline text,
  timeline_date date, created_at timestamptz, first_posted_at timestamptz, expires_at timestamptz,
  bid_count bigint, distance_mi numeric, photo_count bigint, city text, state text, is_dismissed boolean
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
  if not (v_hauler.active and v_hauler.status = 'active') then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;
  v_radius := membership_max_radius_mi(v_hauler.membership_tier);

  return query
    select j.id, j.title, j.description, j.zip, j.status, j.payment_mode,
      j.service_type, j.dumpster_type, j.rental_start_date, j.rental_end_date, j.timeline, j.timeline_date,
      j.created_at, j.first_posted_at, j.expires_at,
      (select count(*) from bids b where b.job_id = j.id) as bid_count,
      case when j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        then null
        else round((earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34)::numeric, 1)
      end as distance_mi,
      (select count(*) from job_photos p where p.job_id = j.id) as photo_count,
      z.city, z.state,
      exists(select 1 from hauler_dismissed_jobs d where d.job_id = j.id and d.hauler_id = auth.uid()) as is_dismissed
    from jobs j
    left join zip_geo z on z.zip = j.zip
    where j.status = 'open' and j.expires_at > now()
      -- Already-bid jobs belong in My Bids, not Find Jobs.
      and not exists (select 1 from bids b2 where b2.job_id = j.id and b2.hauler_id = auth.uid())
      and (
        j.lat is null or j.lng is null or v_hauler.lat is null or v_hauler.lng is null
        or earth_distance(ll_to_earth(v_hauler.lat, v_hauler.lng), ll_to_earth(j.lat, j.lng)) / 1609.34 <= v_radius
      )
    order by distance_mi nulls last;
end;
$$;

-- ─── 4. resolve_bid_revision — add the is_active_user() check propose_bid_revision already has ───
-- Every other job-state RPC checks is_active_user(); this one was missed, so a suspended or
-- deletion-requested customer could still approve/decline a hauler's proposed price change.
create or replace function resolve_bid_revision(p_revision_id uuid, p_approved boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_rev bid_revisions%rowtype;
  v_job jobs%rowtype;
  v_notif_id uuid;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_rev from bid_revisions where id = p_revision_id for update;
  if v_rev.id is null then
    raise exception 'Revision not found';
  end if;
  if v_rev.customer_id <> auth.uid() then
    raise exception 'Only the customer on this job can respond to a price revision';
  end if;
  if v_rev.status <> 'pending' then
    raise exception 'This price revision has already been resolved';
  end if;

  update bid_revisions set status = case when p_approved then 'approved' else 'declined' end, resolved_at = now()
    where id = p_revision_id;

  insert into messages (chat_id, sender_role, text) values (
    v_rev.chat_id, 'system',
    case when p_approved
      then format('✓ Customer approved the new price: $%s.', v_rev.new_amount)
      else format('✗ Customer declined the new price — $%s stands.', v_rev.old_amount)
    end
  );

  select * into v_job from jobs where id = v_rev.job_id;
  insert into notifications (user_id, event_type, title, body, job_id)
    values (v_rev.hauler_id, 'bidRevisionResolved',
      case when p_approved then 'Price change approved on "' || v_job.title || '"' else 'Price change declined on "' || v_job.title || '"' end,
      case when p_approved then format('New price: $%s', v_rev.new_amount) else format('Customer kept the original price: $%s', v_rev.old_amount) end,
      v_rev.job_id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
end;
$$;
