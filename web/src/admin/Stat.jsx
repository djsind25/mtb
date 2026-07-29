import { C, sans, RADIUS, SHADOW_SM } from "../theme";

export function Stat({ label, value, mono: isMono, accent, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, padding: "12px 14px",
        cursor: onClick ? "pointer" : "default", transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.borderColor = C.teal; e.currentTarget.style.boxShadow = SHADOW_SM; } }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = C.line; e.currentTarget.style.boxShadow = "none"; }}
    >
      <div style={{ fontSize: 10.5, color: C.gray, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: sans, fontVariantNumeric: isMono ? "tabular-nums" : undefined, fontSize: 19, fontWeight: 800, color: accent ? C.ember : C.pineDeep }}>{value}</div>
      {onClick && <div style={{ fontSize: 10.5, color: C.teal, fontWeight: 600, marginTop: 4 }}>View details →</div>}
    </div>
  );
}
