// MyTrashBid brand tokens — matches the official brand guidelines (Manrope type, vivid grass
// green as an accent only against clean white/charcoal, Apple/Stripe/Linear-style restraint).
// Token *names* are kept stable across the app on purpose — only the values changed — so every
// component that already reads C.pine / C.sand / etc. picks up the rebrand automatically.
export const C = {
  // Brand green — accent only (buttons, links, highlights), never a dominant fill or background.
  pine: "#38B000", pineDeep: "#111827",
  ember: "#38B000", emberLight: "#EAF9E0",
  // "sand" = page/full-viewport canvas (clean white); "sandWarm" = the one light-gray secondary
  // surface (tab tracks, inset boxes, avatar chips) — see theme.js history for the reasoning.
  sand: "#FFFFFF", sandWarm: "#F5F7F8",
  // "teal" doubles as the semantic success color (booked/paid/won states) — distinct from the
  // primary brand green so success states don't compete visually with primary CTAs.
  teal: "#22C55E", tealLight: "#E7F9EE",
  ink: "#111827", paper: "#FFFFFF", gray: "#6B7280", grayLight: "#F5F7F8",
  line: "#E5E7EB", amber: "#B8860B", amberLight: "#FBF3DD", red: "#C0392B", redLight: "#FBEAE8",
  green: "#38B000", greenDeep: "#22C55E", charcoal: "#111827",
};
// "serif" is a historical name (the app used to use a serif display face for headings) — now
// aliased to Manrope 800 per the brand guidelines. Kept so the ~8 existing heading usages didn't
// all need touching; new headings should just use `heading` directly.
export const heading = "'Manrope', system-ui, sans-serif";
export const serif = heading;
export const sans = "'Manrope', system-ui, sans-serif";
export const mono = "'JetBrains Mono', monospace";

// Design tokens per brand guidelines: 16–20px rounded corners, minimal shadows, 200–300ms
// ease-in-out motion.
export const RADIUS = { sm: 10, md: 14, lg: 18, xl: 20, pill: 999 };
export const SHADOW = "0 1px 2px rgba(17,24,39,0.04), 0 2px 8px rgba(17,24,39,0.05)";
export const SHADOW_MD = "0 4px 16px rgba(17,24,39,0.08)";
export const TRANSITION = "all 220ms ease-in-out";

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
