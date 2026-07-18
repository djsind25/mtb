-- MyTrashBid — lock down internal-only SECURITY DEFINER functions
--
-- Security audit (2026-07-19) finding: a set of SECURITY DEFINER functions that are only ever
-- meant to run from pg_cron, from a trigger, or as an internal call inside another (postgres-owned)
-- definer function were left with Postgres's default PUBLIC execute grant. Because they live in the
-- `public` schema, PostgREST exposes the ones with a callable signature as REST RPC endpoints — and
-- the anon key (embedded in the shipped frontend, so effectively public) was enough to invoke them.
--
-- Confirmed exploitable, UNauthenticated, via POST /rest/v1/rpc/<name>:
--   dispatch_new_job_sms_digest()      → forces the SMS-digest Edge Function to fire (real cost)
--   dispatch_notification_email(uuid)  → forces a notification email dispatch
--   dispatch_notification_sms(uuid)    → forces a notification SMS dispatch
--   dispatch_verification_email(uuid)  → email-spam any profile id with a verification email
--   run_monthly_export() / dispatch_monthly_export(...) → emails revenue data to the super admin
--   send_overdue_reminders() / check_hauler_document_expirations() → mass notification/email generation
--
-- These return void / take scalar args, so they were reachable. The remaining functions below are
-- trigger functions (return trigger) that PostgREST does NOT expose, so they were not directly
-- reachable — but they have no business being PUBLIC-executable either, so they're revoked too for
-- defense in depth and consistency. Trigger execution is not gated by EXECUTE privilege, so this does
-- not affect any trigger firing.
--
-- Why this is safe: every legitimate caller is either pg_cron (runs as postgres, the owner), a
-- trigger (fires regardless of grants), or another SECURITY DEFINER function owned by postgres
-- (definer-privilege call, checked against postgres, not the end user). The owner retains EXECUTE, so
-- none of those paths break. Verified: no frontend code and no Edge Function calls any of these by
-- name. This mirrors the lockdown already applied to handle_inbound_support_email and
-- dispatch_support_reply_email in an earlier migration.
--
-- NOT touched (these are meant to be user-callable and enforce their own authorization internally):
--   the is_admin()/is_full_admin()/is_super_admin()/is_active_user() and customer_owns_job()/
--   hauler_bid_on_job()/job_is_open_for_bid() predicates (must stay executable — RLS policies call
--   them as the invoking user), and the admin RPCs (send_monthly_export_now, set_auto_export_enabled,
--   review_hauler_document, create/cancel/accept/check_admin_invite, accept_bid, confirm_job_complete,
--   renew_job, renew_bid, submit_hauler_document, resend_verification_email, completed_jobs_count,
--   list_open_jobs_for_hauler) which already gate on is_full_admin()/is_super_admin()/auth.uid().

revoke execute on function dispatch_notification_email(uuid) from public;
revoke execute on function dispatch_notification_sms(uuid) from public;
revoke execute on function dispatch_verification_email(uuid) from public;
revoke execute on function dispatch_admin_invite_email(uuid) from public;
revoke execute on function dispatch_monthly_export(date, date) from public;
revoke execute on function dispatch_new_job_sms_digest() from public;
revoke execute on function run_monthly_export() from public;
revoke execute on function send_overdue_reminders() from public;
revoke execute on function check_hauler_document_expirations() from public;

-- Trigger functions — not RPC-reachable, revoked for defense in depth / consistency.
revoke execute on function handle_new_user() from public;
revoke execute on function bids_notify_customer() from public;
revoke execute on function messages_notify_recipient() from public;
revoke execute on function notify_nearby_haulers_of_new_job() from public;
revoke execute on function assign_support_chat_on_admin_reply() from public;
revoke execute on function reopen_support_chat_on_reply() from public;
revoke execute on function update_hauler_rating() from public;
revoke execute on function guard_job_self_update() from public;
revoke execute on function guard_chat_self_update() from public;
revoke execute on function guard_profile_self_update() from public;
revoke execute on function sync_profile_email() from public;
