import { useState } from "react";
import { C, sans, SHADOW_MD } from "../theme";
import { Wordmark } from "./Logo";
import { Btn } from "./Primitives";
import { getOrCreateMySupportChat } from "../support/data";
import { SupportChatThread } from "../support/SupportChatThread";

export function TopBar({ session, onLogout, onNav, page, setToast }) {
  const [supportChatId, setSupportChatId] = useState(null);
  const [openingSupport, setOpeningSupport] = useState(false);

  async function openSupport() {
    setOpeningSupport(true);
    try {
      const chat = await getOrCreateMySupportChat(session.id);
      setSupportChatId(chat.id);
    } catch (e) {
      setToast?.(e.message || "Could not open support chat.");
    }
    setOpeningSupport(false);
  }

  return (
    <>
      <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 18px", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Wordmark size={17} />
          </div>
          {session && session.role === "admin" && (
            <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
              <NavTab label="Admin Dashboard" active={page === "admin"} onClick={() => onNav("admin")} />
            </div>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            {session && (
              <>
                {session.role !== "admin" && (
                  <Btn size="sm" full={false} variant="ghost" onClick={openSupport} disabled={openingSupport}>
                    {openingSupport ? "…" : "🛟 Contact Administrator"}
                  </Btn>
                )}
                <span style={{ fontSize: 12.5, color: C.gray }}>
                  {session.role === "admin" ? "🛡️ Admin" : session.role === "hauler" ? "🚛 " + session.businessName : "👤 " + session.name}
                </span>
                <Btn size="sm" full={false} variant="ghost" onClick={onLogout}>Log out</Btn>
              </>
            )}
          </div>
        </div>
      </div>

      {supportChatId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: C.paper, borderRadius: 20, width: "100%", maxWidth: 480, maxHeight: "88vh", padding: 16, boxSizing: "border-box", boxShadow: SHADOW_MD }}>
            <SupportChatThread supportChatId={supportChatId} viewerRole={session.role} viewerId={session.id} onClose={() => setSupportChatId(null)} setToast={setToast} />
          </div>
        </div>
      )}
    </>
  );
}

function NavTab({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.sandWarm : "transparent", border: "none", borderRadius: 10,
      padding: "7px 13px", fontSize: 13, fontWeight: 600, color: active ? C.pineDeep : C.gray,
      cursor: "pointer", fontFamily: sans,
    }}>{label}</button>
  );
}
