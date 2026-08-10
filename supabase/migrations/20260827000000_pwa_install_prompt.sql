-- MyTrashBid — "Add to Home Screen" install prompt dismissal tracking
--
-- Server-side (not localStorage) so a dismissal is remembered across devices/sessions, same
-- pattern as every other per-user preference in this app (notification_prefs, sms_consent, etc.).
-- Nullable timestamp, not a boolean: null means "never dismissed, eligible to show"; a real
-- timestamp is a permanent "don't show again" (mirrors sms_consent_at's audit-timestamp shape).
-- No guard_profile_self_update() change needed — that trigger is a denylist of fields a user
-- can't self-edit, and this one should always be freely self-editable.
alter table profiles add column pwa_install_dismissed_at timestamptz;
