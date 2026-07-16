import { C, sans, mono, SHADOW } from "../theme";

export function Stat({ label, value, mono: isMono, accent }) {
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 16, padding: "12px 14px", boxShadow: SHADOW }}>
      <div style={{ fontSize: 10.5, color: C.gray, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: isMono ? mono : sans, fontSize: 19, fontWeight: 800, color: accent ? C.ember : C.pineDeep }}>{value}</div>
    </div>
  );
}
