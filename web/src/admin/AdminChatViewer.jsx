import { useEffect, useState } from "react";
import { C, sans, RADIUS, SHADOW_MD } from "../theme";
import { Badge, Btn, CenteredNote } from "../ui/Primitives";
import { loadChat, loadMessages, sendMessage } from "../chat/data";
import { ChatBubble } from "../chat/ChatBubble";
import {
  loadChatAdminSessions, loadSupportRequestsForChat, loadChatAdminAuditLog,
  joinChat, leaveChat, lockChat, unlockChat, resolveSupportRequest, reopenSupportRequest,
} from "./data";

const SUPPORT_STATUS_META = {
  requested: { label: "🆘 Support requested", color: C.amber, bg: C.amberLight },
  active: { label: "🛡️ Support active", color: C.slate, bg: C.slateLight },
  resolved: { label: "✓ Support resolved", color: C.gray, bg: C.grayLight },
};

// Two modes in one component: the 4 pre-existing call sites (FlagRow/JobRow/StalledJobsTab/
// UserReviewPanel) pass neither `viewerId` nor `readOnly`, so they keep getting exactly the old
// read-only transcript view — `readOnly` defaults to true and every control below is gated on
// `!readOnly`. The new Job chat support queue passes both, so a full admin gets real join/leave/
// lock/unlock/resolve/reopen/staff-note controls; a view-only admin (readOnly computed from
// session.adminReadOnly, same as everywhere else in this dashboard) still sees the same
// interactive layout but every mutating control stays disabled — the RPCs would reject them
// server-side regardless, this just avoids a round trip to find that out.
export function AdminChatViewer({ chatId, onClose, viewerId, readOnly = true, setToast = () => {} }) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [requests, setRequests] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [showAudit, setShowAudit] = useState(false);
  const [confirmingLock, setConfirmingLock] = useState(false);
  const [lockReason, setLockReason] = useState("");
  const [confirmingUnlock, setConfirmingUnlock] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolutionNote, setResolutionNote] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenNote, setReopenNote] = useState("");
  const [composeMode, setComposeMode] = useState("participants"); // "participants" | "staff_only"
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);

  async function reload() {
    const [c, m, s, r, a] = await Promise.all([
      loadChat(chatId), loadMessages(chatId), loadChatAdminSessions(chatId), loadSupportRequestsForChat(chatId), loadChatAdminAuditLog(chatId),
    ]);
    setChat(c);
    setMessages(m);
    setSessions(s);
    setRequests(r);
    setAuditLog(a);
  }

  useEffect(() => {
    let cancelled = false;
    reload().catch(() => { if (!cancelled) setMessages([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const hasJoined = viewerId && sessions.some(s => s.admin_id === viewerId && !s.left_at);
  const pendingRequest = requests.find(r => r.status === "pending");

  async function run(action) {
    setWorking(true);
    try {
      await action();
      await reload();
    } catch (e) {
      setToast(e.message || "That action could not be completed.");
    }
    setWorking(false);
  }

  async function handleSend() {
    if (!draft.trim()) return;
    setWorking(true);
    try {
      await sendMessage({ chatId, senderRole: "admin", senderId: viewerId, text: draft.trim(), visibility: composeMode });
      setDraft("");
      await reload();
    } catch (e) {
      setToast(e.message || "Could not send message.");
    }
    setWorking(false);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: RADIUS.lg, boxShadow: SHADOW_MD, width: "100%", maxWidth: readOnly ? 480 : 600, maxHeight: "88vh", border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontFamily: sans, fontSize: 17, fontWeight: 700, color: C.pineDeep }}>{chat?.jobTitle || "Conversation"}</div>
            {chat && (
              <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>
                {chat.customerName} ↔ {chat.businessName} · <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums" }}>${chat.bid_amount}</span>
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {chat && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {chat.payment_mode === "full" ? (
              chat.commission_status === "earned" ? (
                <Badge color={C.teal} bg={C.tealLight}>Released ${chat.bid_amount?.toFixed(2)} (full payment)</Badge>
              ) : (
                <Badge color={C.amber} bg={C.amberLight}>Held ${chat.bid_amount?.toFixed(2)} (full payment)</Badge>
              )
            ) : (
              <>
                <Badge color={C.teal} bg={C.tealLight}>Deposit ${chat.deposit?.toFixed(2)}</Badge>
                <Badge color={C.gray} bg={C.grayLight}>Balance ${chat.balance_due?.toFixed(2)}</Badge>
              </>
            )}
            {chat.reviews_unlocked && <Badge color={C.teal} bg={C.tealLight}>Reviews unlocked</Badge>}
            {chat.support_status !== "none" && (
              <Badge color={SUPPORT_STATUS_META[chat.support_status].color} bg={SUPPORT_STATUS_META[chat.support_status].bg}>
                {SUPPORT_STATUS_META[chat.support_status].label}
              </Badge>
            )}
            {chat.admin_locked_at && <Badge color={C.red} bg={C.redLight}>🔒 Locked</Badge>}
          </div>
        )}

        {!readOnly && chat && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.line}`, background: C.sand, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {hasJoined ? (
                <Btn size="sm" full={false} variant="ghost" disabled={working} onClick={() => run(() => leaveChat(chatId))}>Leave conversation</Btn>
              ) : (
                <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => run(() => joinChat(chatId))}>Join conversation</Btn>
              )}

              {chat.admin_locked_at ? (
                confirmingUnlock ? (
                  <>
                    <span style={{ fontSize: 11.5, color: C.gray, alignSelf: "center" }}>Unlock this conversation?</span>
                    <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => { run(() => unlockChat(chatId)); setConfirmingUnlock(false); }}>Yes, unlock</Btn>
                    <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingUnlock(false)}>Cancel</Btn>
                  </>
                ) : (
                  <Btn size="sm" full={false} variant="ghost" disabled={working} onClick={() => setConfirmingUnlock(true)}>Unlock</Btn>
                )
              ) : confirmingLock ? (
                <>
                  <input value={lockReason} onChange={e => setLockReason(e.target.value)} placeholder="Reason (optional)"
                    style={{ flex: 1, minWidth: 140, border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "6px 10px", fontSize: 12 }} />
                  <Btn size="sm" full={false} variant="danger" disabled={working} onClick={() => { run(() => lockChat(chatId, lockReason.trim() || null)); setConfirmingLock(false); setLockReason(""); }}>Confirm lock</Btn>
                  <Btn size="sm" full={false} variant="ghost" onClick={() => { setConfirmingLock(false); setLockReason(""); }}>Cancel</Btn>
                </>
              ) : (
                <Btn size="sm" full={false} variant="danger" disabled={working} onClick={() => setConfirmingLock(true)}>Lock conversation</Btn>
              )}
            </div>

            {pendingRequest && (
              resolving ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input value={resolutionNote} onChange={e => setResolutionNote(e.target.value)} placeholder="Resolution note (optional)"
                    style={{ flex: 1, minWidth: 140, border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "6px 10px", fontSize: 12 }} />
                  <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => { run(() => resolveSupportRequest(pendingRequest.id, resolutionNote.trim() || null)); setResolving(false); setResolutionNote(""); }}>Confirm resolve</Btn>
                  <Btn size="sm" full={false} variant="ghost" onClick={() => setResolving(false)}>Cancel</Btn>
                </div>
              ) : (
                <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => setResolving(true)}>Resolve support request</Btn>
              )
            )}
            {!pendingRequest && chat.support_status === "resolved" && (
              reopening ? (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <input value={reopenNote} onChange={e => setReopenNote(e.target.value)} placeholder="Why reopen? (optional)"
                    style={{ flex: 1, minWidth: 140, border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "6px 10px", fontSize: 12 }} />
                  <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => { run(() => reopenSupportRequest(chatId, reopenNote.trim() || null)); setReopening(false); setReopenNote(""); }}>Confirm reopen</Btn>
                  <Btn size="sm" full={false} variant="ghost" onClick={() => setReopening(false)}>Cancel</Btn>
                </div>
              ) : (
                <Btn size="sm" full={false} variant="ghost" disabled={working} onClick={() => setReopening(true)}>Reopen support</Btn>
              )
            )}

            {auditLog.length > 0 && (
              <div>
                <button onClick={() => setShowAudit(a => !a)} style={{ background: "none", border: "none", padding: 0, fontSize: 11, fontWeight: 600, color: C.gray, textDecoration: "underline", cursor: "pointer", fontFamily: "inherit" }}>
                  {showAudit ? "Hide" : "Show"} recent admin actions ({auditLog.length})
                </button>
                {showAudit && (
                  <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                    {auditLog.map(a => (
                      <div key={a.id} style={{ fontSize: 11, color: C.gray }}>
                        <strong>{a.adminName || "An admin"}</strong> {a.action.replace(/_/g, " ")}
                        {a.detail && ` — "${a.detail}"`} · {new Date(a.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
          {messages === null && <CenteredNote>Loading conversation…</CenteredNote>}
          {messages?.length === 0 && <CenteredNote>No messages yet.</CenteredNote>}
          {messages?.map(m => <ChatBubble key={m.id} msg={m} viewer="admin" viewerId={viewerId} />)}
        </div>

        {!readOnly && (
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 16px", display: "grid", gap: 8 }}>
            <div style={{ display: "flex", gap: 12, fontSize: 11.5 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: composeMode === "participants" ? C.pineDeep : C.gray, fontWeight: composeMode === "participants" ? 700 : 400 }}>
                <input type="radio" checked={composeMode === "participants"} onChange={() => setComposeMode("participants")} />
                Message (visible to everyone)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: composeMode === "staff_only" ? C.slate : C.gray, fontWeight: composeMode === "staff_only" ? 700 : 400 }}>
                <input type="radio" checked={composeMode === "staff_only"} onChange={() => setComposeMode("staff_only")} />
                🔒 Staff note (admins only)
              </label>
            </div>
            {composeMode === "participants" && !hasJoined && (
              <div style={{ fontSize: 11.5, color: C.gray }}>Join the conversation above to send a message everyone can see.</div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea value={draft} onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                placeholder={composeMode === "staff_only" ? "Internal note…" : "Message about this job…"} rows={1}
                disabled={composeMode === "participants" && !hasJoined}
                style={{ flex: 1, resize: "none", border: `1.5px solid ${C.line}`, borderRadius: 20, padding: "9px 15px", fontSize: 13.5, fontFamily: "inherit", outline: "none", color: C.ink, background: (composeMode === "participants" && !hasJoined) ? C.grayLight : C.sand }} />
              <Btn size="sm" full={false} disabled={!draft.trim() || working || (composeMode === "participants" && !hasJoined)} onClick={handleSend}>Send</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
