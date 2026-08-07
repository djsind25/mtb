import { C, sans } from "../theme";

export function Stat({ label, value, hint, mono: isMono, accent, onClick }) {
  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`admin-kpi${onClick ? " admin-kpi--interactive" : ""}`}
    >
      <span className="admin-kpi__label">{label}</span>
      <span style={{
        display: "block", fontFamily: sans, fontVariantNumeric: isMono ? "tabular-nums" : undefined,
        fontSize: 28, lineHeight: 1.1, fontWeight: 800, color: accent ? C.pine : C.pineDeep,
      }}>{value}</span>
      {hint && <span className="admin-kpi__hint">{hint}</span>}
      {onClick && <span className="admin-kpi__arrow" aria-hidden="true">→</span>}
    </Tag>
  );
}
