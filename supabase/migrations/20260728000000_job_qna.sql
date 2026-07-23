-- MyTrashBid — public Q&A on job listings, post-posting job updates, and free-form bid editing
--
-- Lets a hauler ask a scope question on an open job before bidding; the customer's answer is
-- visible to every hauler within bidding radius (not just the asker), so scope gets clarified
-- once instead of the same question landing in a dozen private DMs. Read-only once a bid is
-- accepted — private chat takes over from there. Alongside this: an append-only "job updates"
-- log so the customer can add detail/photos after posting without silently rewriting the
-- original listing, and free-form bid editing so a hauler can revise their price/note while
-- it's still pending.
--
-- This is the first table in this schema that needs the 50-mile radius enforced at the RLS
-- layer itself (job_photos_select today lets *any* hauler see photos while a job is open, not
-- just nearby ones — radius has only ever been enforced at the list_open_jobs_for_hauler browse
-- layer) — hauler_within_radius_of_job() below is a new, reusable predicate for that.

-- ─── Radius predicate, extracted from list_open_jobs_for_hauler()'s inline math ───────────────
-- Fails open on unknown coordinates, same as that RPC — an unresolvable ZIP shouldn't silently
-- hide a job's Q&A from a hauler who'd otherwise see the job itself in their browse list.
create function hauler_within_radius_of_job(p_job_id uuid) returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from jobs j, profiles p
      where j.id = p_job_id and p.id = auth.uid()
        and (
          j.lat is null or j.lng is null or p.lat is null or p.lng is null
          or earth_distance(ll_to_earth(p.lat, p.lng), ll_to_earth(j.lat, j.lng)) / 1609.34
              <= app_config_numeric('max_radius_mi')
        )
    );
  $$;

-- ─── Real masking (not just detection) for text broadcast to a whole radius of haulers ────────
-- is_flaggable() only ever detects and lets an admin review after the fact — fine for a 1:1 chat,
-- not for an answer every bidder on the job sees the moment it's posted. Reuses the same
-- phone/email patterns is_flaggable() matches, substituting them out instead of just flagging.
create function mask_contact_info(p_text text) returns text
  language sql immutable as $$
    select regexp_replace(
      regexp_replace(p_text, '\d{3}[-.\s]?\d{3}[-.\s]?\d{4}', '[removed]', 'g'),
      '[\w.+-]+@[\w-]+\.[a-z]{2,}', '[removed]', 'gi'
    );
  $$;

-- ─── job_questions ──────────────────────────────────────────────────────────────────────────
create table job_questions (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  hauler_id     uuid not null references profiles(id),
  question      text not null,
  answer        text,
  answered_at   timestamptz,
  flag_type     text check (flag_type in ('warned', 'warned-repeat')),
  flag_reviewed boolean not null default false,
  created_at    timestamptz not null default now()
);
create index job_questions_job_id_idx on job_questions(job_id);

-- ─── job_updates — append-only, customer-authored detail log ──────────────────────────────────
create table job_updates (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  text          text not null,
  flag_type     text check (flag_type in ('warned', 'warned-repeat')),
  flag_reviewed boolean not null default false,
  created_at    timestamptz not null default now()
);
create index job_updates_job_id_idx on job_updates(job_id);

-- ─── Anonymity: hauler_id only reaches the job's own customer or an admin ──────────────────────
-- RLS is row-level, not column-level — hiding the asker from other haulers has to happen in a
-- view a client can't work around by querying the base table (which authenticated never gets a
-- select grant on at all, only this view does). Left at Postgres's default non-security_invoker
-- behavior, same as public_profiles, so it runs with the view owner's privileges and can apply
-- its own row/column logic regardless of the querying role's own RLS.
create view job_questions_public as
  select jq.id, jq.job_id, jq.question, jq.answer, jq.answered_at, jq.created_at,
    jq.flag_type, jq.flag_reviewed,
    case when customer_owns_job(jq.job_id) or is_admin() then jq.hauler_id else null end as hauler_id
  from job_questions jq
  where customer_owns_job(jq.job_id) or hauler_within_radius_of_job(jq.job_id)
     or hauler_owns_chat_job(jq.job_id) or is_admin();

-- No identity to hide here (always customer-authored) — this view exists mainly so `select`
-- never needs to be granted on the base table either, keeping both new tables the same shape.
create view job_updates_public as
  select ju.*
  from job_updates ju
  where customer_owns_job(ju.job_id) or hauler_within_radius_of_job(ju.job_id)
     or hauler_owns_chat_job(ju.job_id) or is_admin();

-- ─── Moderation triggers ────────────────────────────────────────────────────────────────────
-- Escalation ("warned" -> "warned-repeat") is counted per-job rather than per-author: a single
-- flag_type column covers a row that can have two different authors (hauler's question, customer's
-- answer), so "has this job already had a flagged Q&A row" is the simplest coherent signal,
-- rather than trying to track hauler-flags and customer-flags as separate escalation counters.
create function mask_and_flag_job_question() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  prior_flags int;
begin
  if tg_op = 'INSERT' then
    new.question := mask_contact_info(new.question);
  end if;
  if new.answer is not null and (tg_op = 'INSERT' or new.answer is distinct from old.answer) then
    new.answer := mask_contact_info(new.answer);
  end if;

  if is_flaggable(new.question) or (new.answer is not null and is_flaggable(new.answer)) then
    select count(*) into prior_flags from job_questions
      where job_id = new.job_id and flag_type is not null and id is distinct from new.id;
    new.flag_type := case when prior_flags >= 1 then 'warned-repeat' else 'warned' end;
  end if;
  return new;
end;
$$;
create trigger job_questions_before_insert before insert on job_questions
  for each row execute function mask_and_flag_job_question();
create trigger job_questions_before_update_answer before update of answer on job_questions
  for each row execute function mask_and_flag_job_question();

create function mask_and_flag_job_update() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  prior_flags int;
begin
  new.text := mask_contact_info(new.text);
  if is_flaggable(new.text) then
    select count(*) into prior_flags from job_updates where job_id = new.job_id and flag_type is not null;
    new.flag_type := case when prior_flags >= 1 then 'warned-repeat' else 'warned' end;
  end if;
  return new;
end;
$$;
create trigger job_updates_before_insert before insert on job_updates
  for each row execute function mask_and_flag_job_update();

-- ─── Guard: a customer answering can't also rewrite the hauler's question ──────────────────────
create function guard_job_question_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or auth.role() = 'service_role'
     or coalesce(current_setting('app.bypass_job_question_guard', true), '') = 'true' then
    return new;
  end if;
  if new.job_id is distinct from old.job_id or new.hauler_id is distinct from old.hauler_id
     or new.question is distinct from old.question or new.created_at is distinct from old.created_at then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;
create trigger job_questions_guard_update before update on job_questions
  for each row execute function guard_job_question_update();

-- ─── Notifications: customer on a new question, hauler on their question being answered ───────
-- The anonymity rule only hides the asker from *other* haulers — their own notification still
-- goes to their real id, same as every other notification in this app.
create function job_questions_notify_customer() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_notif_id uuid;
begin
  select * into v_job from jobs where id = new.job_id;
  insert into notifications (user_id, event_type, title, body, job_id)
    values (v_job.customer_id, 'jobQuestionAsked', 'New question on "' || v_job.title || '"', left(new.question, 140), new.job_id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
  return new;
end;
$$;
create trigger job_questions_after_insert after insert on job_questions
  for each row execute function job_questions_notify_customer();

create function job_questions_notify_hauler() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_job jobs%rowtype;
  v_notif_id uuid;
begin
  select * into v_job from jobs where id = new.job_id;
  insert into notifications (user_id, event_type, title, body, job_id)
    values (new.hauler_id, 'questionAnswered', 'Your question was answered on "' || v_job.title || '"', left(new.answer, 140), new.job_id)
    returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);
  perform dispatch_notification_sms(v_notif_id);
  return new;
end;
$$;
create trigger job_questions_after_update_answer after update of answer on job_questions
  for each row when (new.answer is not null and old.answer is null)
  execute function job_questions_notify_hauler();

-- ─── RLS ────────────────────────────────────────────────────────────────────────────────────
alter table job_questions enable row level security;
alter table job_updates enable row level security;

-- Narrow on purpose: a hauler can only ever see their OWN rows via the base table (needed so
-- the insert policy's self-count subquery below can even evaluate — Postgres requires a SELECT
-- grant to run any subquery against a table, RLS or not). Reading another hauler's question
-- anonymized, or the customer's/admin's full view, only ever happens through
-- job_questions_public — this policy never widens that.
create policy job_questions_select on job_questions for select using (
  hauler_id = auth.uid() or customer_owns_job(job_id) or is_admin()
);
grant select on job_questions to authenticated;

-- No license/insurance requirement, unlike bids_insert — asking a question is meant to be a
-- lower bar than bidding. The count(*) < 3 subquery is the "3 open unanswered questions per
-- hauler per job" cap, enforced here (not just client-side).
create policy job_questions_insert on job_questions for insert with check (
  hauler_id = auth.uid() and is_active_user() and job_is_open_for_bid(job_id)
  and hauler_within_radius_of_job(job_id)
  and (select count(*) from job_questions q
       where q.job_id = job_questions.job_id and q.hauler_id = auth.uid() and q.answer is null) < 3
);

-- Admin can always update (e.g. flip flag_reviewed) regardless of job status; the customer can
-- only answer/edit while the job is still open — this is what makes Q&A read-only after booking.
create policy job_questions_update on job_questions for update
  using (is_admin() or (customer_owns_job(job_id) and is_active_user() and job_is_open_for_bid(job_id)))
  with check (is_admin() or (customer_owns_job(job_id) and is_active_user() and job_is_open_for_bid(job_id)));

-- Genuinely append-only for the customer — no customer update/delete policy at all, so a
-- correction becomes a new entry rather than editing history. Admin still needs to flip
-- flag_reviewed for the Trust & Safety queue, same trust-the-admin-UI shape as
-- messages_update_admin (no column-level lock — the admin dashboard only ever sends
-- {flag_reviewed}).
create policy job_updates_insert on job_updates for insert with check (
  customer_owns_job(job_id) and is_active_user() and job_is_open_for_bid(job_id)
);
create policy job_updates_update_admin on job_updates for update using (is_full_admin()) with check (is_full_admin());

grant select on job_questions_public, job_updates_public to authenticated;
grant insert, update on job_questions to authenticated;
grant insert, update on job_updates to authenticated;
grant all on job_questions, job_updates, job_questions_public, job_updates_public to service_role;

-- ─── Bid editing: free-form while pending (no update policy on bids existed before this) ──────
create function guard_bid_self_update() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if is_full_admin() or auth.role() = 'service_role'
     or coalesce(current_setting('app.bypass_bid_guard', true), '') = 'true' then
    return new;
  end if;
  if new.job_id is distinct from old.job_id or new.hauler_id is distinct from old.hauler_id
     or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
    raise exception 'Not permitted to change this field.';
  end if;
  return new;
end;
$$;
create trigger bids_guard_self_update before update on bids
  for each row execute function guard_bid_self_update();

create policy bids_update on bids for update
  using (hauler_id = auth.uid() and is_active_user() and job_is_open_for_bid(job_id) and expires_at > now())
  with check (hauler_id = auth.uid() and is_active_user() and job_is_open_for_bid(job_id) and expires_at > now());

grant update on bids to authenticated;

-- renew_bid() already updates expires_at directly (that's its whole job) — the new guard above
-- would otherwise reject it, since expires_at is one of the locked columns. Same bypass-flag
-- pattern renew_job/accept_bid already use for jobs_guard_self_update.
create or replace function renew_bid(p_bid_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_bid bids%rowtype;
  v_job jobs%rowtype;
begin
  if not is_active_user() then
    raise exception 'Your account has been deactivated. Contact support if you believe this is a mistake.';
  end if;

  select * into v_bid from bids where id = p_bid_id for update;
  if v_bid.id is null then
    raise exception 'Bid not found';
  end if;
  if v_bid.hauler_id <> auth.uid() then
    raise exception 'Only the bidding hauler can renew this bid';
  end if;
  select * into v_job from jobs where id = v_bid.job_id;
  if v_job.status <> 'open' then
    raise exception 'This job is no longer open';
  end if;
  perform set_config('app.bypass_bid_guard', 'true', true);
  update bids set created_at = now(), expires_at = now() + make_interval(days => app_config_numeric('live_window_days')::int)
    where id = p_bid_id;
end;
$$;

-- ─── Notification event types ──────────────────────────────────────────────────────────────
alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived', 'bidAccepted', 'newMessage', 'jobCompleted', 'reminderOverdue', 'documentExpiring',
  'documentExpired', 'newJobNearby', 'jobBooked', 'adminMessage', 'jobMarkedDone', 'bidSwitchedOut',
  'cancellationRequested', 'jobCancelled', 'jobQuestionAsked', 'questionAnswered'
]));

-- Same jsonb_set-merge technique as 20260719000000_sms_notifications.sql — merges into the
-- existing events/smsEvents sub-objects so no user's other preferences get clobbered.
alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": true,
    "jobCompleted": true,
    "reminderOverdue": true,
    "jobBooked": true,
    "jobQuestionAsked": true,
    "questionAnswered": true
  },
  "smsEvents": {
    "newJobNearby": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true,
    "adminMessage": true,
    "jobQuestionAsked": true,
    "questionAnswered": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  jsonb_set(
    notification_prefs,
    '{events}',
    coalesce(notification_prefs->'events', '{}'::jsonb) || '{"jobQuestionAsked": true, "questionAnswered": true}'::jsonb
  ),
  '{smsEvents}',
  coalesce(notification_prefs->'smsEvents', '{}'::jsonb) || '{"jobQuestionAsked": true, "questionAnswered": true}'::jsonb
);
