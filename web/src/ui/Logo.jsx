import { C, sans } from "../theme";

export function LogoMark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" style={{ flexShrink: 0 }} aria-label="MyTrashBid">
      <circle cx="37" cy="9" r="7.5" fill={C.green} />
      <path d="M37 16.5 L33.5 12 L40.5 12 Z" fill={C.green} />
      <text x="37" y="12.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff" fontFamily="Manrope, sans-serif">$</text>
      <rect x="5" y="15" width="34" height="6" rx="1.5" fill={C.charcoal} />
      <path d="M8 21 H36 L33.5 39 H10.5 Z" fill={C.green} />
      <circle cx="14" cy="41.5" r="2.4" fill={C.charcoal} />
      <circle cx="30" cy="41.5" r="2.4" fill={C.charcoal} />
      <circle cx="22" cy="30" r="7" fill="#fff" />
      <path d="M18.5 30 L21 32.5 L26 27" stroke={C.green} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Wordmark({ size = 17 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <LogoMark size={size + 9} />
      <span style={{ fontFamily: sans, fontWeight: 800, fontSize: size, letterSpacing: "-0.02em" }}>
        <span style={{ color: C.charcoal }}>My</span><span style={{ color: C.green }}>Trash</span><span style={{ color: C.charcoal }}>Bid</span>
      </span>
    </div>
  );
}
