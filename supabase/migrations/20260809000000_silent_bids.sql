-- Silent bids: a customer sees anonymized "Hauler 1", "Hauler 2"... labels instead of real
-- business names while a job is still open, so they can compare trust badges (licensed/insured/
-- verified/rating/member-since) and prices without knowing who's who — mirrors the app's existing
-- posture of masking sensitive info server-side (see mask_contact_info) rather than just hiding it
-- in the UI, so a customer inspecting network requests can't glean identity before accepting.
-- Real identity is revealed only for whichever bid becomes jobs.accepted_bid_id once booked.
--
-- Numbering is stable across reloads and consistent between the bid list and job Q&A: it's based
-- on each hauler's earliest interaction with the job (first bid OR first question, whichever came
-- first), not display order, so "Hauler 2" always refers to the same hauler everywhere on that job.
create or replace function job_hauler_display(p_job_id uuid)
returns table(
  hauler_id uuid,
  label text,
  business_name text,
  rating numeric,
  rating_count integer,
  verified boolean,
  license_active boolean,
  insurance_active boolean,
  member_since timestamptz,
  membership_tier text,
  revealed boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (customer_owns_job(p_job_id) or is_admin()) then
    raise exception 'Not authorized to view this job.';
  end if;

  return query
  with participants as (
    select b_or_q.hauler_id, min(b_or_q.created_at) as first_seen
    from (
      select bids.hauler_id, bids.created_at from bids where bids.job_id = p_job_id
      union all
      select job_questions.hauler_id, job_questions.created_at from job_questions
        where job_questions.job_id = p_job_id and job_questions.hauler_id is not null
    ) b_or_q
    group by b_or_q.hauler_id
  ),
  labeled as (
    select participants.hauler_id, 'Hauler ' || row_number() over (order by participants.first_seen) as label
    from participants
  ),
  accepted as (
    select b.hauler_id as accepted_hauler_id
    from jobs j join bids b on b.id = j.accepted_bid_id
    where j.id = p_job_id and j.status = 'booked'
  )
  select
    l.hauler_id, l.label,
    case when a.accepted_hauler_id = l.hauler_id then p.business_name else null end,
    p.rating, p.rating_count, p.verified, p.license_active, p.insurance_active, p.created_at, p.membership_tier,
    coalesce(a.accepted_hauler_id = l.hauler_id, false)
  from labeled l
  join public_profiles p on p.id = l.hauler_id
  left join accepted a on true;
end;
$$;

grant execute on function job_hauler_display(uuid) to authenticated;
