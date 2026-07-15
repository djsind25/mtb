import { C, mono } from "../theme";

export function SummaryStrip({ stats }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(120px, 1fr))`, gap: 10, marginBottom: 20 }}>
      {stats.map(s => (
        <div key={s.label} style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontFamily: mono, fontSize: 20, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>{s.value}</div>
          <div style={{ fontSize: 11, color: C.gray, lineHeight: 1.3 }}>{s.label}</div>
        </div>
      ))}
    </div>
  );
}
