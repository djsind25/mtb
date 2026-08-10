-- MyTrashBid — one-off: mark the "Test Haulers Co" account (dsm3kgt@gmail.com) license/insurance
-- verified so it can actually submit a bid and ask a job question, for testing the notification-
-- defaults/chat-throttling/install-prompt work from this session. Normally this happens through
-- the admin document-review flow (hauler_verification_documents.sql) or the admin override RPC
-- (20260816000000_hauler_verification_override.sql) — this bypasses both since it's a disposable
-- test account with no real documents to review, not a real hauler being vetted.
--
-- guard_profile_self_update() (20260816000000_hauler_verification_override.sql) now blocks direct
-- writes to license_active/insurance_active unconditionally, even from a migration/service-role
-- session — only the admin override RPC (which sets this same flag internally) is allowed through.
select set_config('app.bypass_profile_guard', 'true', true);
update profiles set license_active = true, insurance_active = true
where email = 'dsm3kgt@gmail.com' and role = 'hauler';
