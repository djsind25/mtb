import { useState } from "react";
import { C } from "../theme";
import { nowStr } from "../theme";
import { AdminChatViewer } from "./AdminChatViewer";
import { setFlagReviewed, setJobQuestionFlagReviewed, setJobUpdateFlagReviewed } from "./data";

// One merged Trust & Safety queue covers three flaggable sources — a chat message (flag.text,
// flag.sender_role, flag.chat_id to open the full conversation), a Q&A entry (flag.question +
// optional flag.answer, no conversation to open), or a job update (flag.text, always
// customer-authored). kind picks which shape a given row is and which reviewed-toggle RPC to use.
export function FlagRow({ flag, expanded, onChanged, readOnly }) {
  const [viewingChat, setViewingChat] = useState(false);
  const [working, setWorking] = useState(false);
  const kind = flag.kind || "chat";
  const isRepeat = flag.flag_type === "warned-repeat";
  const reviewed = !!flag.flag_reviewed;

  async function toggleReviewed(e) {
    const next = e.target.checked;
    setWorking(true);
    try {
      if (kind === "question") await setJobQuestionFlagReviewed(flag.id, next);
      else if (kind === "update") await setJobUpdateFlagReviewed(flag.id, next);
      else await setFlagReviewed(flag.id, next);
      onChanged?.();
    } finally {
      setWorking(false);
    }
  }

  // A job_questions row can be flagged for either half — the hauler's question or the
  // customer's answer — and flag_type doesn't track which, so naming just the asker here would
  // misattribute the violation whenever it's actually the answer that tripped it. The expanded
  // text below shows both halves, so the admin can see for themselves which one it is.
  const headerLabel = kind === "question"
    ? "Question/answer on a job listing"
    : kind === "update"
    ? `${flag.senderName || "Customer"} — job update`
    : `${flag.senderName || "Unknown"} (${flag.sender_role})`;

  return (
    <div style={{
      border: `1px solid ${reviewed ? C.line : (isRepeat ? C.red : C.amber) + "55"}`,
      background: reviewed ? C.paper : (isRepeat ? C.redLight : C.amberLight),
      borderRadius: 10, padding: "10px 12px", opacity: reviewed ? 0.65 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: reviewed ? C.gray : (isRepeat ? C.red : "#8A6604") }}>
          {isRepeat ? "🚩 Repeat offense" : "🛡️ First flag"} — {headerLabel}
        </span>
        <span style={{ fontSize: 10.5, color: C.gray, whiteSpace: "nowrap" }}>{nowStr(flag.created_at)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 4 }}>Job: {flag.jobTitle || "—"}</div>
      {expanded && (
        <div style={{ fontSize: 13, color: C.ink, background: C.paper, borderRadius: 8, padding: "8px 10px", marginBottom: 8 }}>
          {kind === "question" ? (
            <>
              <div>Q: "{flag.question}"</div>
              {flag.answer && <div style={{ marginTop: 6 }}>A: "{flag.answer}"</div>}
            </>
          ) : (
            <>"{flag.text}"</>
          )}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
        {kind === "chat" && flag.chat_id ? (
          <button onClick={() => setViewingChat(true)} style={{
            background: "none", border: "none", padding: 0, fontSize: 11.5, fontWeight: 600,
            color: isRepeat && !reviewed ? C.red : "#8A6604", textDecoration: "underline", cursor: "pointer", fontFamily: "inherit",
          }}>
            View full conversation →
          </button>
        ) : <span />}
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.ink, cursor: readOnly ? "default" : "pointer" }}>
          <input type="checkbox" checked={reviewed} disabled={working || readOnly} onChange={toggleReviewed} />
          Reviewed
        </label>
      </div>
      {viewingChat && <AdminChatViewer chatId={flag.chat_id} onClose={() => setViewingChat(false)} />}
    </div>
  );
}
