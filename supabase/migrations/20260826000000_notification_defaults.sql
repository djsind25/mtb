-- MyTrashBid — sane notification defaults so new users aren't bombarded
--
-- Every event has defaulted to ON since day one (see the notification_prefs column default's
-- history across init_schema/sms_notifications/job_qna/bid_revisions/full_payment_scheduling/
-- admin_chat_participation/web_push). This flips the default to ON-only-for-transactional /
-- OFF-for-informational, per the notification-settings product spec. SMS defaults are
-- deliberately left untouched — the SMS opt-in UI is still hidden (see
-- web/src/dashboard/AccountTab.jsx), so there's nothing live for a changed SMS default to affect
-- yet; that's its own follow-up once SMS ships.
--
-- Only the column DEFAULT changes, so this only affects brand-new signups (none of the profile-
-- insert paths — auto_create_profile_on_signup, custom_email_verification, admin_invites,
-- sms_notifications — set notification_prefs explicitly, they all rely on this default). No
-- existing profile's events map is touched, since every key below already exists on every
-- existing row (each was unconditionally backfilled to true when it was introduced) — there's no
-- way to tell "explicitly saved by the user" from "never touched, still on the old default" once
-- both look identical, so per the instruction to preserve what existing users already have, the
-- safe choice is to leave every existing row alone.
--
-- documentExpiring/documentExpired are the one exception: neither key was ever added to the
-- default blob (a pre-existing gap, not a decision — hauler_verification_documents.sql never
-- touched notification_prefs), so every existing row is genuinely missing them, not just
-- inheriting an old true. That's an unambiguous "hasn't been explicitly set" case, so those two
-- get backfilled below the same way pushEvents/jobQuestionAsked/etc. were backfilled when they
-- were first introduced.
alter table profiles alter column notification_prefs set default '{
  "email": true,
  "sms": false,
  "events": {
    "bidReceived": true,
    "bidAccepted": true,
    "newMessage": false,
    "jobCompleted": true,
    "reminderOverdue": false,
    "jobBooked": true,
    "jobQuestionAsked": false,
    "questionAnswered": false,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true,
    "documentExpiring": false,
    "documentExpired": true,
    "adminJoined": true,
    "supportResolved": true,
    "chatLocked": true,
    "chatUnlocked": true
  },
  "smsEvents": {
    "newJobNearby": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true,
    "adminMessage": true,
    "jobQuestionAsked": true,
    "questionAnswered": true,
    "bidRevisionProposed": true,
    "bidRevisionResolved": true,
    "scheduleProposed": true,
    "scheduleConfirmed": true,
    "coordinationNudge": true,
    "paymentAuthorized": true
  },
  "pushEvents": {
    "bidReceived": true,
    "bidAccepted": true,
    "jobBooked": true,
    "newMessage": true
  }
}'::jsonb;

update profiles set notification_prefs = jsonb_set(
  jsonb_set(
    notification_prefs,
    '{events,documentExpiring}',
    'false'::jsonb
  ),
  '{events,documentExpired}',
  'true'::jsonb
)
where not (notification_prefs->'events' ? 'documentExpiring') or not (notification_prefs->'events' ? 'documentExpired');
