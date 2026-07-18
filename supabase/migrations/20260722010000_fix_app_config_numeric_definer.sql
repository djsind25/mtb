-- MyTrashBid — fix app_config_numeric() for regular users
--
-- 20260718090000_monthly_auto_export.sql correctly locked app_config's SELECT policy down to
-- is_admin() (it holds internal_dispatch_key, a real secret) but never updated app_config_numeric()
-- to bypass that restriction — it's a plain (non-SECURITY DEFINER) function, so every non-admin
-- caller of it now silently fails to read config. Both jobs_set_expiry and bids_set_expiry call it
-- to compute expiration dates on every job/bid insert:
--   - bids.expires_at is NOT NULL, so every hauler's bid submission has been hard-failing.
--   - jobs.expires_at is nullable, so a verified customer's job silently gets expires_at = null
--     instead of erroring (still wrong — the job just never expires).
--
-- Found while testing Phase 1 of the payment rework. No real customers/haulers exist yet (still
-- test phase), so this bundles into the same deploy rather than going out as a separate hotfix.
--
-- Fix: mark it SECURITY DEFINER (same pattern as get_default_payment_mode() above) so it always
-- resolves regardless of caller, while direct SELECT on the table itself stays admin-only. Safe
-- against the exact leak that migration was preventing — the numeric cast means a non-numeric
-- secret like internal_dispatch_key simply fails to cast rather than being returned as text.
create or replace function app_config_numeric(p_key text) returns numeric
  language sql stable security definer set search_path = public as $$
    select value::numeric from app_config where key = p_key;
  $$;
