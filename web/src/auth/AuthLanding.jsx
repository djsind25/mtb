import { C, sans, SHADOW } from "../theme";
import { LogoMark } from "../ui/Logo";

export function AuthLanding({ onPick }) {
  return (
    <div style={{ minHeight: "100vh", background: C.paper, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: sans }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <LogoMark size={64} />
          </div>
          <div style={{ fontFamily: sans, fontWeight: 800, fontSize: 30, letterSpacing: "-0.02em", marginBottom: 6 }}>
            <span style={{ color: C.charcoal }}>My</span><span style={{ color: C.green }}>Trash</span><span style={{ color: C.charcoal }}>Bid</span>
          </div>
          <div style={{ fontSize: 15, color: C.charcoal, fontWeight: 600 }}>Snap. <span style={{ color: C.green }}>Get Quotes.</span> Done.</div>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <RoleCard
            icon="👤" title="I'm a customer" desc="Post a job or rent a dumpster"
            onClick={() => onPick("customer")}
          />
          <RoleCard
            icon="🚛" title="I'm a hauler / dumpster rental business" desc="Bid on jobs, manage your profile"
            onClick={() => onPick("hauler")}
          />
        </div>

        <div style={{ textAlign: "center", marginTop: 24 }}>
          <button onClick={() => onPick("admin")} style={{ background: "none", border: "none", color: C.gray, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
            Admin login
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleCard({ icon, title, desc, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 18, padding: "20px", boxShadow: SHADOW,
      display: "flex", alignItems: "center", gap: 14, cursor: "pointer", textAlign: "left", fontFamily: sans,
      transition: "border-color 220ms ease-in-out",
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = C.pine}
      onMouseLeave={e => e.currentTarget.style.borderColor = C.line}
    >
      <div style={{ fontSize: 28 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.pineDeep, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.gray }}>{desc}</div>
      </div>
      <div style={{ color: C.gray }}>→</div>
    </button>
  );
}
