// Junk-removal-specific content and tunable business rules for MyTrashBid, centralized so a
// future fork into a different local-services vertical (event rentals, PDR, etc.) can reskin by
// swapping this one file. Values here were moved verbatim from where they used to live inline —
// this file changes nothing about how the app looks or behaves today.
//
// Deliberately NOT here: anything that would be identical in any vertical — the bidding engine,
// auth, Stripe/payment logic, chat, contact masking, radius math, expiry logic, reviews, the admin
// dashboard shell, membership/2FA. Also not here: the many one-off transactional strings (empty
// states, chat monitoring banner paragraphs, cancellation warnings, "held by MyTrashBid" notices)
// — those are woven into flow-specific JSX that a real fork would rewrite anyway, so pre-wiring
// them through a config layer would add indirection without saving real work.
export const VERTICAL = {
  brand: {
    name: "MyTrashBid",
    namePart1: "MyTrash",
    namePart2: "Bid",
  },

  roles: {
    customer: {
      label: "Customer",
      pluralLabel: "Customers",
      pickerIcon: "👤",
      pickerTitle: "I'm a customer",
      pickerDesc: "Post a job or rent a dumpster",
    },
    hauler: {
      label: "Hauler",
      pluralLabel: "Haulers",
      pickerIcon: "🚛",
      pickerTitle: "I'm a hauler / dumpster rental business",
      pickerDesc: "Bid on jobs, manage your profile",
    },
  },

  jobCategories: [
    { id: "removal", label: "🧹 Junk removal" },
    { id: "rolloff", label: "🗑️ Roll-off dumpster" },
    { id: "trailer", label: "🚛 Trailer rental" },
  ],

  postForm: {
    serviceTypeOptions: [
      { id: "removal", label: "Junk removal" },
      { id: "rental", label: "Dumpster / trailer rental" },
    ],
    dumpsterTypeOptions: [
      { id: "rolloff", label: "🗑️ Roll-off dumpster" },
      { id: "trailer", label: "🚛 Trailer" },
    ],
    whatDoYouNeedLabel: "What do you need?",
    titleLabel: "Job title",
    titlePlaceholder: "Old couch + mattresses",
    descriptionLabel: "Description",
    descriptionPlaceholder: "What needs to go, roughly how much, any access notes…",
    descriptionTip: "Tip: approximate measurements and weight (e.g. \"couch, ~150 lbs, about 7ft long\") help haulers bid accurately.",
    zipPlaceholder: "60491",
    submitLabelRemoval: "Post job",
    submitLabelRental: "Post rental request",
  },

  vetting: {
    docLabels: { license: "Business license", insurance: "Insurance" },
    intro: "Both a current license and insurance must be approved before you can bid on jobs. Submitting a new document resets its status to pending until an admin reviews it.",
    fields: [
      { key: "verified", label: "Verified hauler", docType: null },
      { key: "license_active", label: "Verified business license", docType: "license" },
      { key: "insurance_active", label: "Verified insurance", docType: "insurance" },
    ],
    howWeVerify: {
      license: { icon: "🪪", title: "Licensed", desc: "their state/local business license is uploaded and checked by our admin team before it's marked active." },
      insurance: { icon: "🛡️", title: "Insured", desc: "a current Certificate of Insurance (COI) is uploaded and its coverage dates are verified." },
      verified: { icon: "✅", title: "Verified", desc: "once both are confirmed, the hauler is cleared to bid on jobs. Badges are rechecked as documents near expiration." },
    },
  },

  businessRules: {
    maxRadiusMi: 50,
    commissionRate: 0.10,
    liveWindowDaysRemoval: 14,
    liveWindowDaysRental: 30,
  },
};
