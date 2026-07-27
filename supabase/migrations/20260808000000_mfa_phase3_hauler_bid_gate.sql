-- MFA Phase 3: haulers must have a verified TOTP factor before they can bid, once they're
-- already bid-eligible (license_active and insurance_active). Same enforcement mechanism as the
-- existing license/insurance/monthly-cap checks in this policy — a plain RLS `with check` clause,
-- not a separate RPC — so it can never be bypassed by calling something other than the normal
-- bids insert. user_has_verified_mfa() already exists from Phase 1
-- (20260806000000_mfa.sql).
drop policy bids_insert on bids;
create policy bids_insert on bids for insert with check (
  hauler_id = auth.uid()
  and is_active_user()
  and exists (
    select 1 from profiles
    where profiles.id = auth.uid() and profiles.role = 'hauler'
      and profiles.license_active and profiles.insurance_active
  )
  and user_has_verified_mfa(auth.uid())
  and job_is_open_for_bid(bids.job_id)
  and (
    (select membership_max_bids_per_month(membership_tier) from profiles where id = auth.uid()) is null
    or (select count(*) from bids b2 where b2.hauler_id = auth.uid()
         and date_trunc('month', b2.created_at) = date_trunc('month', now()))
       < (select membership_max_bids_per_month(membership_tier) from profiles where id = auth.uid())
  )
);
