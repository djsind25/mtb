import { C, sans } from "../theme";
import { Wordmark } from "./Logo";
import { Btn } from "./Primitives";

export function TopBar({ session, onLogout, onNav, page }) {
  return (
    <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 18px", position: "sticky", top: 0, zIndex: 50 }}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Wordmark size={17} />
        </div>
        {session && (
          <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
            {session.role !== "admin" && (
              <NavTab label="Jobs" active={page === "jobs"} onClick={() => onNav("jobs")} />
            )}
            {session.role !== "admin" && (
              <NavTab label="Chats" active={page === "chats"} onClick={() => onNav("chats")} />
            )}
            {session.role === "admin" && (
              <NavTab label="Admin Dashboard" active={page === "admin"} onClick={() => onNav("admin")} />
            )}
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {session && (
            <>
              <span style={{ fontSize: 12.5, color: C.gray }}>
                {session.role === "admin" ? "🛡️ Admin" : session.role === "hauler" ? "🚛 " + session.businessName : "👤 " + session.name}
              </span>
              <Btn size="sm" full={false} variant="ghost" onClick={onLogout}>Log out</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NavTab({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.sandWarm : "transparent", border: "none", borderRadius: 7,
      padding: "7px 13px", fontSize: 13, fontWeight: 600, color: active ? C.pineDeep : C.gray,
      cursor: "pointer", fontFamily: sans,
    }}>{label}</button>
  );
}
