import { C, sans } from "../theme";

export function SummaryStrip({ stats }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fit, minmax(120px, 1fr))`, gap: 10, marginBottom: 20 }}>
      {stats.map(s => {
        const cardStyle = {
          background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px",
          textAlign: "left", fontFamily: "inherit",
        };
        const content = (
          <>
            <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontSize: 20, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>{s.value}</div>
            <div style={{ fontSize: 11, color: C.gray, lineHeight: 1.3 }}>{s.label}</div>
          </>
        );
        return s.onClick ? (
          <button key={s.label} onClick={s.onClick} style={{ ...cardStyle, cursor: "pointer" }}>
            {content}
          </button>
        ) : (
          <div key={s.label} style={cardStyle}>
            {content}
          </div>
        );
      })}
    </div>
  );
}
