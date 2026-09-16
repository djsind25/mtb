-- Two gaps surfaced by the pre-launch security checklist review (2026-09-04):
--
-- 1. is_admin()/is_full_admin()/is_super_admin() only ever checked profiles.role -- an admin
--    session that has never completed (or never enrolled) MFA still passes every RLS policy and
--    RPC gated on these, as long as the JWT's sub belongs to an admin row. The React app's own
--    login flow (App.jsx finishLogin) already forces every admin through MFA enrollment/challenge
--    before ever reaching the dashboard -- but that's a client-side gate a caller can skip by
--    talking to the REST API directly with a stolen or pre-MFA-challenge admin JWT. This adds the
--    same aal2 requirement require_aal2() already enforces on destructive actions to the
--    read/role-check layer itself, closing the gap everywhere these three functions are used in
--    one pass rather than patching each policy individually. A legitimate admin is unaffected: by
--    the time finishLogin() ever sets stage="app", their session has already reached aal2, and
--    Supabase preserves aal across token refresh for the life of that session.
--
-- 2. enable_confirmations=false (deliberate -- see 20260715172159_custom_email_verification.sql)
--    means Supabase's own auth.users.email_confirmed_at is set on every signup regardless of
--    whether the person ever proved they own that inbox. Supabase's built-in behavior auto-links
--    a new OAuth identity onto an existing account once that account's email is confirmed --
--    which is trivially always true here. Nothing stops someone from squatting a real customer's
--    email via a password signup they never verify, then having that customer's later Google
--    sign-in silently merge into the squatter's account (the same mechanism, harmlessly, produced
--    today's dsm3kgt@gmail.com duplicate-account situation). This app's OWN verification
--    (profiles.email_verified_at, via the separate verify_email() flow) is the only real signal of
--    inbox ownership for a password signup -- OAuth signups get it set immediately in
--    complete_oauth_profile() instead, since Google already verified them. GoTrue's internal
--    linking decision isn't exposed to app code, so instead of trying to patch that directly, this
--    closes the exploitable window: sweep away password-signup profiles that never completed real
--    verification and have zero real activity, past a grace period -- forever becomes a few days
--    -- and separately, notify an account holder any time a new sign-in identity gets linked onto
--    their existing profile, so if a merge like this ever isn't harmless, they get a real signal.

-- --- 1. is_admin() / is_full_admin() / is_super_admin() now require a current aal2 session -----

create or replace function is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
        and coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    );
  $$;

create or replace function is_full_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin' and not admin_read_only
        and coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    );
  $$;

create or replace function is_super_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin' and super_admin
        and coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
    );
  $$;

-- --- 2. Sweep never-verified, zero-activity password signups after a grace period ----------------

insert into app_config (key, value) values ('unverified_signup_purge_hours', '72')
  on conflict (key) do nothing;

create function purge_stale_unverified_signups() returns void
  language plpgsql security definer set search_path = public as $$
declare
  r record;
begin
  for r in
    select p.id from profiles p
    where p.email_verified_at is null
      and p.role in ('customer', 'hauler')
      and p.created_at < now() - make_interval(hours => app_config_numeric('unverified_signup_purge_hours')::int)
      and not exists (select 1 from jobs where jobs.customer_id = p.id)
      and not exists (select 1 from bids where bids.hauler_id = p.id)
      and not exists (select 1 from chats where chats.customer_id = p.id or chats.hauler_id = p.id)
      and not exists (select 1 from hauler_documents where hauler_documents.hauler_id = p.id)
      and not exists (select 1 from payments py join jobs j on j.id = py.job_id where j.customer_id = p.id)
    for update skip locked
  loop
    begin
      delete from auth.users where id = r.id;
    exception when foreign_key_violation then
      raise warning 'purge_stale_unverified_signups: could not delete % (activity appeared)', r.id;
    end;
  end loop;
end;
$$;
revoke execute on function purge_stale_unverified_signups() from public;

select cron.schedule('purge-unverified-signups', '17 */6 * * *', $cron$select purge_stale_unverified_signups()$cron$);

-- --- 3. Notify the account holder whenever a NEW identity is linked onto an EXISTING profile -----

alter table notifications drop constraint notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check check (event_type = any (array[
  'bidReceived','bidAccepted','newMessage','jobCompleted','reminderOverdue','documentExpiring',
  'documentExpired','newJobNearby','jobBooked','adminMessage','jobMarkedDone','bidSwitchedOut',
  'cancellationRequested','jobCancelled','jobQuestionAsked','questionAnswered','bidRevisionProposed',
  'bidRevisionResolved','scheduleProposed','scheduleConfirmed','coordinationNudge','paymentAuthorized',
  'supportRequested','adminJoined','supportResolved','chatLocked','chatUnlocked','disputeOpened',
  'disputeResolved','jobRemoved','jobPaused','newSupportMessage','identityLinked'
]));

create function notify_new_identity_linked() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_identity_count int;
  v_notif_id uuid;
begin
  select count(*) into v_identity_count from auth.identities where user_id = new.user_id;
  if v_identity_count <= 1 then
    return new;
  end if;
  if not exists (select 1 from profiles where id = new.user_id) then
    return new;
  end if;

  insert into notifications (user_id, event_type, title, body)
  values (new.user_id, 'identityLinked', 'A new sign-in method was added to your account',
    format('A "%s" sign-in was just linked to your account. If this was not you, contact support immediately.', new.provider))
  returning id into v_notif_id;
  perform dispatch_notification_email(v_notif_id);

  return new;
end;
$$;

create trigger on_auth_identity_linked
  after insert on auth.identities
  for each row execute function notify_new_identity_linked();
