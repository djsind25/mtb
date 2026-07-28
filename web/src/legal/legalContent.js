// Single source of truth for the ToS/Privacy version numbers used by the acceptance-recording
// flow, and where to view the full text. The actual prose lives in site/terms.html and
// site/privacy.html (the marketing site) — when that wording changes, bump the matching version
// number here too (and update the <meta name="doc-version"> tag in that HTML file to match).
// Bumping a version causes every existing customer/hauler to be prompted to re-accept next login
// (see needsLegalReaccept in ../lib/legal.js and App.jsx's legal_reaccept stage) without losing
// their prior acceptance history — record_legal_acceptance() never overwrites past rows.
export const TOS_VERSION = 1;
export const TOS_EFFECTIVE_DATE = "2026-07-28";
export const PRIVACY_VERSION = 1;
export const PRIVACY_EFFECTIVE_DATE = "2026-07-28";

export const TOS_URL = "https://mytrashbid.com/terms.html";
export const PRIVACY_URL = "https://mytrashbid.com/privacy.html";
