import { useEffect, useState } from "react";
import { C, serif, mono } from "../theme";
import { Badge, CenteredNote } from "../ui/Primitives";
import { loadChat, loadMessages } from "../chat/data";
import { ChatBubble } from "../chat/ChatBubble";

// Read-only — admin can see every message (including flag styling) for oversight, but this
// view never writes to the chat. Passing viewer="admin" to ChatBubble (a role that never
// matches a real sender_role) makes every bubble render as "other", left-aligned by sender
// avatar, which is exactly the neutral third-party read reflected here.
export function AdminChatViewer({ chatId, onClose }) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadChat(chatId), loadMessages(chatId)]).then(([c, m]) => {
      if (cancelled) return;
      setChat(c);
      setMessages(m);
    });
    return () => { cancelled = true; };
  }, [chatId]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: 16, width: "100%", maxWidth: 480, maxHeight: "85vh", border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontFamily: serif, fontSize: 17, fontWeight: 700, color: C.pineDeep }}>{chat?.jobTitle || "Conversation"}</div>
            {chat && (
              <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>
                {chat.customerName} ↔ {chat.businessName} · <span style={{ fontFamily: mono }}>${chat.bid_amount}</span>
              </div>
            )}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        {chat && (
          <div style={{ padding: "10px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Badge color={C.teal} bg={C.tealLight}>Deposit ${chat.deposit?.toFixed(2)}</Badge>
            <Badge color={C.gray} bg={C.grayLight}>Balance ${chat.balance_due?.toFixed(2)}</Badge>
            {chat.reviews_unlocked && <Badge color={C.teal} bg={C.tealLight}>Reviews unlocked</Badge>}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
          {messages === null && <CenteredNote>Loading conversation…</CenteredNote>}
          {messages?.length === 0 && <CenteredNote>No messages yet.</CenteredNote>}
          {messages?.map(m => <ChatBubble key={m.id} msg={m} viewer="admin" />)}
        </div>
      </div>
    </div>
  );
}
