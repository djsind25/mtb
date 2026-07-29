// MyTrashBid brand tokens — ported verbatim from the prototype (junk-bids-platform-full.jsx)
// so the production app looks identical. Palette pulled from the MyTrashBid logo: vivid grass
// green + deep charcoal on clean white.
export const C = {
  pine: "#41A62E", pineDeep: "#16232D",
  ember: "#41A62E", emberLight: "#E9F6E6",
  sand: "#F6F8F5", sandWarm: "#EDF2EA",
  teal: "#2E7D22", tealLight: "#E2F2DE",
  ink: "#16232D", paper: "#FFFFFF", gray: "#5E6B63", grayLight: "#E4E9E3",
  line: "#D8E0D6", amber: "#B8860B", amberLight: "#FBF3DD", red: "#C0392B", redLight: "#FBEAE8",
  // Neutral blue-gray for monitoring/security surfaces — distinct from the warning (amber) and
  // success (teal) palettes, so "we're watching for safety" doesn't read as a warning.
  slate: "#5B6B7A", slateLight: "#EEF1F3",
};
export const sans = "'Inter', system-ui, sans-serif";

// Additive scale for the chat redesign's card style — soft shadows and 12-16px radii instead of
// the flat/no-shadow look most of the app still uses. Not retrofitted everywhere yet.
export const RADIUS = { sm: 8, md: 12, lg: 16 };
export const SHADOW_SM = "0 1px 2px rgba(22,35,45,0.06)";
export const SHADOW_MD = "0 2px 10px rgba(22,35,45,0.08)";

export const MAX_RADIUS_MI = 50;
export const COMMISSION_RATE = 0.10;

export const TIMELINE_OPTIONS = [
  { id: "asap", label: "ASAP", sub: "within 48 hours" },
  { id: "this_week", label: "This week" },
  { id: "next_2_weeks", label: "Next 2 weeks" },
  { id: "this_month", label: "This month" },
  { id: "flexible", label: "Flexible / no rush" },
];

// Legacy jobs from before this field existed have timeline = null — treated as "no badge"
// rather than guessing, so old test/demo data never renders "undefined" or a misleading label.
export function timelineMeta(timeline) {
  const opt = TIMELINE_OPTIONS.find(o => o.id === timeline);
  if (!opt) return null;
  return { label: opt.label, urgent: timeline === "asap", color: timeline === "asap" ? C.red : C.gray, bg: timeline === "asap" ? C.redLight : C.grayLight };
}

// "Soonest timeline" sort orders by this index — legacy jobs with no timeline sort as if
// "flexible" (last), matching the grouping HaulerDashboard already used for the timeline filter.
export function timelineSortIndex(timeline) {
  const idx = TIMELINE_OPTIONS.findIndex(o => o.id === timeline);
  return idx === -1 ? TIMELINE_OPTIONS.length - 1 : idx;
}

// The only job-type distinctions that exist in the data model today (service_type +, for
// rentals, dumpster_type) — mirrors the labels PostJobForm and HaulerJobCard already use.
export const JOB_CATEGORY_OPTIONS = [
  { id: "removal", label: "🧹 Junk removal" },
  { id: "rolloff", label: "🗑️ Roll-off dumpster" },
  { id: "trailer", label: "🚛 Trailer rental" },
];
export function jobCategoryOf(job) {
  if (job.service_type !== "rental") return "removal";
  return job.dumpster_type === "trailer" ? "trailer" : "rolloff";
}

// "Highest value" was requested but skipped — jobs have no budget/estimate field in the data
// model, and inventing one would misrepresent what haulers are actually seeing.
export const JOB_SORT_OPTIONS = [
  { id: "nearest", label: "Nearest" },
  { id: "newest", label: "Newest" },
  { id: "fewest_bids", label: "Fewest bids" },
  { id: "soonest_timeline", label: "Soonest timeline" },
];

export function nowStr(iso) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function isExpired(iso) {
  return !!iso && Date.now() > new Date(iso).getTime();
}
export function daysLeft(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
export function expiryLabel(iso) {
  if (isExpired(iso)) return "Expired";
  const d = daysLeft(iso);
  if (d === 0) return "Expires today";
  if (d === 1) return "1 day left";
  return `${d} days left`;
}
export function memberSinceLabel(iso) {
  if (!iso) return null;
  return `Member since ${new Date(iso).getFullYear()}`;
}
export function shortDateLabel(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
