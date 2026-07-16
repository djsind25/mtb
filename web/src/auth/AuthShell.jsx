import { C, serif, sans } from "../theme";

export function AuthShell({ title, subtitle, onBack, children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.sandWarm, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: sans }}>
      <div style={{ width: "100%", maxWidth: 400, background: C.paper, borderRadius: 16, padding: 28, border: `1px solid ${C.line}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.gray, fontSize: 13, cursor: "pointer", marginBottom: 14 }}>← Back</button>
        <div style={{ fontFamily: serif, fontSize: 22, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 13, color: C.gray, marginBottom: 20 }}>{subtitle}</div>
        {children}
      </div>
    </div>
  );
}
