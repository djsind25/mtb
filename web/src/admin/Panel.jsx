import { C, SHADOW } from "../theme";

export function Panel({ title, children }) {
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 18, padding: 16, boxShadow: SHADOW }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.03em" }}>{title}</div>
      {children}
    </div>
  );
}
