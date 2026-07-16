import { useState } from "react";
import { C } from "../theme";
import { nowStr } from "../theme";
import { AdminChatViewer } from "./AdminChatViewer";
import { setFlagReviewed } from "./data";

export function FlagRow({ flag, expanded, onChanged }) {
  const [viewingChat, setViewingChat] = useState(false);
  const [working, setWorking] = useState(false);
  const isRepeat = flag.flag_type === "warned-repeat";
  const reviewed = !!flag.flag_reviewed;

  async function toggleReviewed(e) {
    const next = e.target.checked;
    setWorking(true);
    try {
      await setFlagReviewed(flag.id, next);
      onChanged?.();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div style={{
      border: `1px solid ${reviewed ? C.line : (isRepeat ? C.red : C.amber) + "55"}`,
      background: reviewed ? C.paper : (isRepeat ? C.redLight : C.amberLight),
      borderRadius: 10, padding: "10px 12px", opacity: reviewed ? 0.65 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: reviewed ? C.gray : (isRepeat ? C.red : "#8A6604") }}>
          {isRepeat ? "🚩 Repeat offense" : "🛡️ First flag"} — {flag.senderName || "Unknown"} ({flag.sender_role})
        </span>
        <span style={{ fontSize: 10.5, color: C.gray, whiteSpace: "nowrap" }}>{nowStr(flag.created_at)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 4 }}>Job: {flag.jobTitle || "—"}</div>
      {expanded && <div style={{ fontSize: 13, color: C.ink, background: C.paper, borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>"{flag.text}"</div>}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        {flag.chat_id ? (
          <button onClick={() => setViewingChat(true)} style={{
            background: "none", border: "none", padding: 0, fontSize: 11.5, fontWeight: 600,
            color: isRepeat && !reviewed ? C.red : "#8A6604", textDecoration: "underline", cursor: "pointer", fontFamily: "inherit",
          }}>
            View full conversation →
          </button>
        ) : <span />}
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.ink, cursor: "pointer" }}>
          <input type="checkbox" checked={reviewed} disabled={working} onChange={toggleReviewed} />
          Reviewed
        </label>
      </div>
      {viewingChat && <AdminChatViewer chatId={flag.chat_id} onClose={() => setViewingChat(false)} />}
    </div>
  );
}
