import { useEffect, useRef, useState } from "react";
import { C, nowStr } from "../theme";
import { CenteredNote, Btn } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import { loadSupportMessages, sendSupportMessage, closeSupportChat, loadSupportChatStatus, reopenSupportChat } from "./data";

export function SupportChatThread({ supportChatId, viewerRole, viewerId, title, onClose, setToast, readOnly }) {
  const [messages, setMessages] = useState(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  // null until loaded — every caller of this component only ever kept the chat's id around, not
  // its status, and a chat can now arrive here already auto-closed (see
  // auto_close_stale_support_chats), so this can no longer default to "open".
  const [status, setStatus] = useState(null);
  const [closedAt, setClosedAt] = useState(null);
  const [closedByAdmin, setClosedByAdmin] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadSupportChatStatus(supportChatId).then(c => {
      if (cancelled) return;
      setStatus(c.status);
      setClosedAt(c.closed_at);
      setClosedByAdmin(!!c.closed_by);
    });
    return () => { cancelled = true; };
  }, [supportChatId]);

  useEffect(() => {
    let cancelled = false;
    loadSupportMessages(supportChatId).then(m => { if (!cancelled) setMessages(m); });
    return () => { cancelled = true; };
  }, [supportChatId]);

  useEffect(() => {
    const channel = supabase
      .channel(`support-messages-${supportChatId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "support_messages", filter: `support_chat_id=eq.${supportChatId}` },
        (payload) => {
          setMessages(prev => (prev || []).some(m => m.id === payload.new.id) ? prev : [...(prev || []), payload.new]);
          if (payload.new.sender_role !== "admin") setStatus("open");
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supportChatId]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages?.length]);

  async function send() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await sendSupportMessage({ supportChatId, senderId: viewerId, senderRole: viewerRole, text: draft.trim() });
      setDraft("");
    } catch (e) {
      setToast(e.message || "Could not send message.");
    }
    setSending(false);
  }

  async function handleClose() {
    setClosing(true);
    try {
      await closeSupportChat(supportChatId);
      setStatus("closed");
      setClosedAt(new Date().toISOString());
      setClosedByAdmin(true);
      setToast("Ticket marked resolved.");
    } catch (e) {
      setToast(e.message || "Could not close this ticket.");
    }
    setClosing(false);
  }

  async function handleReopen() {
    setReopening(true);
    try {
      await reopenSupportChat(supportChatId);
      setStatus("open");
      setClosedAt(null);
      setClosedByAdmin(false);
    } catch (e) {
      setToast(e.message || "Could not reopen this ticket.");
    }
    setReopening(false);
  }

  if (messages === null || status === null) return <CenteredNote>Loading…</CenteredNote>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 160px)", minHeight: 360 }}>
      <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 13, cursor: "pointer", marginBottom: 10, textAlign: "left" }}>← Back</button>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 14, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 16px", fontSize: 14, fontWeight: 700, color: C.pineDeep }}>
          {title || "Contact Administrator"}
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
          {messages.length === 0 && <CenteredNote>No messages yet — say hello.</CenteredNote>}
          {messages.map(m => {
            if (m.admin_only) {
              return (
                <div key={m.id} style={{ textAlign: "center", margin: "10px 14px", fontSize: 11, color: C.gray, fontStyle: "italic" }}>
                  🔒 {m.text} · {nowStr(m.created_at)} <span title="Only visible to admins">(admin-only note)</span>
                </div>
              );
            }
            const isSelf = m.sender_id === viewerId;
            const isAdmin = m.sender_role === "admin";
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: isSelf ? "flex-end" : "flex-start", margin: "4px 14px" }}>
                <div style={{ maxWidth: "78%" }}>
                  {!isSelf && isAdmin && <div style={{ fontSize: 10.5, color: C.teal, fontWeight: 700, marginBottom: 2 }}>🛡️ MyTrashBid Support</div>}
                  <div style={{
                    background: isSelf ? C.pine : C.paper, color: isSelf ? C.paper : C.ink,
                    border: isSelf ? "none" : `1px solid ${C.line}`,
                    borderRadius: 16, borderBottomRightRadius: isSelf ? 4 : 16, borderBottomLeftRadius: isSelf ? 16 : 4,
                    padding: "9px 13px", fontSize: 13.5, lineHeight: 1.5,
                  }}>{m.text}</div>
                  <div style={{ fontSize: 10, color: C.gray, marginTop: 2, textAlign: isSelf ? "right" : "left" }}>{nowStr(m.created_at)}</div>
                </div>
              </div>
            );
          })}
        </div>

        {viewerRole === "admin" && readOnly && (
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 16px", fontSize: 12, color: C.gray, textAlign: "center" }}>
            👁️ View-only admin — can't reply to tickets.
          </div>
        )}

        {!(viewerRole === "admin" && readOnly) && status === "closed" && (
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 16px", textAlign: "center" }}>
            <div style={{ fontSize: 12, color: C.gray, marginBottom: 8 }}>
              {closedByAdmin
                ? `Marked resolved${closedAt ? ` on ${nowStr(closedAt)}` : ""}.`
                : `Auto-closed after a week of inactivity${closedAt ? ` (${nowStr(closedAt)})` : ""}.`}
            </div>
            <Btn size="sm" full={false} onClick={handleReopen} disabled={reopening}>
              {reopening ? "Reopening…" : "↺ Reopen chat"}
            </Btn>
          </div>
        )}

        {!(viewerRole === "admin" && readOnly) && status === "open" && (
          <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 12px" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea value={draft} onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Message support…" rows={1}
                style={{ flex: 1, resize: "none", border: `1.5px solid ${C.line}`, borderRadius: 20, padding: "9px 15px", fontSize: 13.5, fontFamily: "inherit", outline: "none", color: C.ink, background: C.sand }} />
              <button onClick={send} disabled={!draft.trim() || sending} style={{
                width: 36, height: 36, borderRadius: "50%", flexShrink: 0, border: "none",
                cursor: draft.trim() ? "pointer" : "default", background: draft.trim() ? C.ember : C.grayLight,
                color: C.paper, fontSize: 14,
              }}>➤</button>
            </div>
            {viewerRole === "admin" && (
              <div style={{ marginTop: 8 }}>
                <Btn size="sm" full={false} variant="ghost" onClick={handleClose} disabled={closing}>
                  {closing ? "Closing…" : "✓ Mark resolved / addressed"}
                </Btn>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
