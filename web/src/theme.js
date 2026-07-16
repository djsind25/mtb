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
  green: "#41A62E", greenDeep: "#2E7D22", charcoal: "#16232D",
};
export const serif = "'Fraunces', Georgia, serif";
export const sans = "'Inter', system-ui, sans-serif";
export const mono = "'JetBrains Mono', monospace";

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
