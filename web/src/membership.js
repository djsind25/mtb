// Single source of truth for membership-tier entitlements — infrastructure only, every tier
// resolves to the same numbers today (no Stripe billing, no upgrade flow; see Account tab).
//
// This file is the canonical definition a human edits first, but two server-side wiring points
// (list_open_jobs_for_hauler's radius, bids_insert's monthly cap) can't import a JS file — they
// read matching values from small SQL functions in
// supabase/migrations/20260730000000_membership_and_profile_locking.sql
// (membership_max_radius_mi / membership_commission_rate / membership_max_bids_per_month). If you
// change an entitlement here, change it there too.
export const MEMBERSHIP_TIERS = {
  free: {
    name: "Free",
    monthlyPrice: 0,
    entitlements: {
      maxBidsPerMonth: null,
      maxRadiusMi: 50,
      earlyAccessMinutes: 0,
      commissionRate: 0.10,
      featuredPlacement: false,
      verifiedBadgeEligible: true,
    },
  },
  pro: {
    name: "Pro",
    monthlyPrice: 0,
    entitlements: {
      maxBidsPerMonth: null,
      maxRadiusMi: 50,
      earlyAccessMinutes: 0,
      commissionRate: 0.10,
      featuredPlacement: false,
      verifiedBadgeEligible: true,
    },
  },
  premium: {
    name: "Premium",
    monthlyPrice: 0,
    entitlements: {
      maxBidsPerMonth: null,
      maxRadiusMi: 50,
      earlyAccessMinutes: 0,
      commissionRate: 0.10,
      featuredPlacement: false,
      verifiedBadgeEligible: true,
    },
  },
};

// Existing haulers predate membership_tier and may carry a null/unrecognized value — treat
// anything unknown as free rather than throwing, matching how every other new-column rollout in
// this app treats pre-existing rows.
export function entitlementsFor(tier) {
  return (MEMBERSHIP_TIERS[tier] || MEMBERSHIP_TIERS.free).entitlements;
}

export function tierName(tier) {
  return (MEMBERSHIP_TIERS[tier] || MEMBERSHIP_TIERS.free).name;
}
