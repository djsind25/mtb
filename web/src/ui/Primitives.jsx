import { C, sans, RADIUS, TRANSITION } from "../theme";

export function Btn({ children, onClick, disabled, variant = "primary", size = "md", full = true, type = "button" }) {
  const bg = disabled ? C.grayLight
    : variant === "primary" ? C.ember
    : variant === "dark" ? C.pineDeep
    : variant === "teal" ? C.teal
    : variant === "danger" ? C.red
    : "transparent";
  const color = disabled ? C.gray : variant === "ghost" ? C.pine : C.paper;
  const border = variant === "ghost" ? `1.5px solid ${C.line}` : "none";
  return (
    <button type={type} onClick={disabled ? undefined : onClick} style={{
      width: full ? "100%" : "auto", background: bg, color, border, borderRadius: RADIUS.md,
      padding: size === "lg" ? "14px 24px" : size === "sm" ? "8px 14px" : "11px 18px",
      fontSize: size === "lg" ? 15 : size === "sm" ? 12.5 : 14, fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer", fontFamily: sans, transition: TRANSITION,
    }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.filter = "brightness(1.08)"; }}
      onMouseLeave={e => { e.currentTarget.style.filter = ""; }}
    >{children}</button>
  );
}

export function Field({ label, value, onChange, type = "text", placeholder, required, hint }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>{label}{required && <span style={{ color: C.red }}> *</span>}</label>}
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm,
          padding: "10px 13px", fontSize: 14, fontFamily: sans, outline: "none", color: C.ink, background: C.paper,
          transition: TRANSITION,
        }}
      />
      {hint && <div style={{ fontSize: 11, color: C.gray, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Badge({ children, color = C.teal, bg = C.tealLight }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, color, background: bg, borderRadius: RADIUS.pill, padding: "3px 9px", letterSpacing: "0.02em" }}>{children}</span>;
}

export function Avatar({ emoji, size = 36, bg = C.grayLight }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>{emoji}</div>;
}

export function CenteredNote({ children }) {
  return <div style={{ textAlign: "center", color: C.gray, fontSize: 13, padding: "30px 0" }}>{children}</div>;
}

export function ErrorMsg({ children }) {
  return <div style={{ fontSize: 12.5, color: C.red, background: C.redLight, borderRadius: RADIUS.sm, padding: "8px 12px", marginBottom: 14 }}>⚠ {children}</div>;
}
