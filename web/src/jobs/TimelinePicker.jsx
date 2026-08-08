import { C, sans, TIMELINE_OPTIONS } from "../theme";

export function TimelinePicker({ value, onChange, dateValue, onDateChange }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {TIMELINE_OPTIONS.map(o => (
          <button key={o.id} type="button" onClick={() => onChange(o.id)} style={{
            border: `1.5px solid ${value === o.id ? C.pine : C.line}`, borderRadius: 10,
            background: value === o.id ? C.tealLight : C.paper, padding: "10px 12px",
            cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: C.ink, fontFamily: sans, textAlign: "left",
          }}>
            {o.label}
            {o.sub && <div style={{ fontSize: 10.5, fontWeight: 400, color: C.gray, marginTop: 1 }}>{o.sub}</div>}
          </button>
        ))}
      </div>
      {value === "specific_date" && (
        <input type="date" value={dateValue || ""} min={today} onChange={e => onDateChange(e.target.value)} style={{
          marginTop: 8, border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "9px 12px",
          fontSize: 13, fontFamily: sans, color: C.ink, outline: "none",
        }} />
      )}
    </div>
  );
}
