-- 20260906000000_connect_onboarding.sql revoked EXECUTE on apply_connect_account_status from
-- public but never re-granted it to service_role (mpb's equivalent migration does both) — every
-- real account.updated webhook has been failing with "permission denied for function
-- apply_connect_account_status" since that migration first shipped. Confirmed live against a real
-- Stripe test-mode Connect account before writing this fix.
grant execute on function apply_connect_account_status(text, boolean, boolean, boolean) to service_role;
