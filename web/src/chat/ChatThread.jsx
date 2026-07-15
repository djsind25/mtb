import { useEffect, useRef, useState } from "react";
import { C, mono } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { Avatar, Badge, CenteredNote } from "../ui/Primitives";
import { loadChat, loadMessages, sendMessage, markChatRead } from "./data";
import { ChatBubble } from "./ChatBubble";
import { ReviewPanel } from "./ReviewPanel";

export function ChatThread({ chatId, session, onClose, setToast }) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [bannerExpanded, setBannerExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadChat(chatId), loadMessages(chatId)]).then(([c, m]) => {
      if (cancelled) return;
      setChat(c);
      setMessages(m);
    });
    markChatRead(chatId, session.role).catch(() => {});
    return () => { cancelled = true; };
  }, [chatId, session.role]);

  // Two postgres_changes bindings on a single channel silently breaks delivery of both in
  // this Realtime version (confirmed empirically) — one channel per table subscribed.
  useEffect(() => {
    const messagesChannel = supabase
      .channel(`chat-messages-${chatId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
        (payload) => setMessages(prev => prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new]))
      .subscribe();
    const chatChannel = supabase
      .channel(`chat-updates-${chatId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chats", filter: `id=eq.${chatId}` },
        (payload) => setChat(prev => ({ ...prev, ...payload.new })))
      .subscribe();
    return () => { supabase.removeChannel(messagesChannel); supabase.removeChannel(chatChannel); };
  }, [chatId]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages.length]);

  if (!chat) return <CenteredNote>Loading chat…</CenteredNote>;

  const viewer = session.role; // "customer" | "hauler"

  async function send() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await sendMessage({ chatId, senderRole: viewer, senderId: session.id, text: draft.trim() });
      setDraft("");
    } catch (e) {
      setToast(e.message || "Could not send message.");
    }
    setSending(false);
  }

  const otherName = viewer === "customer" ? chat.businessName : chat.customerName;
  const otherIsBiz = viewer === "customer";
  const deposit = chat.deposit;
  const balanceDue = chat.balance_due;

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "16px 16px 0", display: "flex", flexDirection: "column", height: "calc(100vh - 64px)" }}>
      <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 13, cursor: "pointer", marginBottom: 10, textAlign: "left" }}>← Back to chats</button>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 14, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar emoji={otherIsBiz ? "🚛" : "👤"} bg={otherIsBiz ? C.tealLight : C.sandWarm} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep }}>{otherName}</div>
            <div style={{ fontSize: 11, color: C.gray }}>{chat.jobTitle}</div>
          </div>
          <Badge color={C.gray} bg={C.grayLight}>🛡️ Monitored</Badge>
        </div>

        <div style={{ background: C.amberLight, borderBottom: `1px solid ${C.amber}33`, padding: bannerExpanded ? "12px 16px" : "9px 16px" }}>
          <button onClick={() => setBannerExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0, fontFamily: "inherit", textAlign: "left" }}>
            <span>🛡️</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#8A6604", flex: 1 }}>This chat is monitored to keep the platform fair</span>
            <span style={{ fontSize: 11, color: "#8A6604" }}>{bannerExpanded ? "▲" : "▼"}</span>
          </button>
          {bannerExpanded && (
            <div style={{ fontSize: 12, color: "#6B5103", lineHeight: 1.55, marginTop: 8, paddingLeft: 22 }}>
              Paying your hauler the remaining balance directly is expected and fine. What we do flag is sharing contact info to arrange jobs <em>outside</em> MyTrashBid to skip the deposit that keeps this service running. First mentions send with a warning; repeated attempts are flagged for Trust &amp; Safety review.
            </div>
          )}
        </div>

        <div style={{ background: C.sand, padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontFamily: mono, fontSize: 17, fontWeight: 700, color: C.pineDeep }}>${chat.bid_amount} total</span>
            <Badge color={C.teal} bg={C.tealLight}>✓ Deposit paid</Badge>
          </div>
          <div style={{ fontSize: 11.5, color: C.gray, display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span>Deposit paid to MyTrashBid (10%)</span>
            <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${deposit.toFixed(2)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: C.gray, display: "flex", justifyContent: "space-between" }}>
            <span>{viewer === "hauler" ? "You collect directly at completion" : "Pay hauler directly at completion"}</span>
            <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${balanceDue.toFixed(2)}</span>
          </div>
        </div>

        {chat.reviews_unlocked && (
          <ReviewPanel chat={chat} chatId={chatId} viewer={viewer} setToast={setToast} />
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
          {messages.map(m => <ChatBubble key={m.id} msg={m} viewer={viewer} />)}
        </div>

        <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 12px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Message about this job…" rows={1}
              style={{ flex: 1, resize: "none", border: `1.5px solid ${C.line}`, borderRadius: 20, padding: "9px 15px", fontSize: 13.5, fontFamily: "inherit", outline: "none", color: C.ink, background: C.sand }} />
            <button onClick={send} disabled={!draft.trim() || sending} style={{
              width: 36, height: 36, borderRadius: "50%", flexShrink: 0, border: "none",
              cursor: draft.trim() ? "pointer" : "default", background: draft.trim() ? C.ember : C.grayLight,
              color: C.paper, fontSize: 14,
            }}>➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}
