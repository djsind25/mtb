import { useCallback, useEffect, useState } from "react";
import { C, mono, SHADOW } from "../theme";
import { Avatar, CenteredNote } from "../ui/Primitives";
import { loadMyChats } from "../chat/data";
import { ChatThread } from "../chat/ChatThread";

export function MessagesTab({ session, setToast, initialChatId, onConsumedInitialChat }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeChatId, setActiveChatId] = useState(initialChatId || null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      setChats(await loadMyChats(session.id));
    } catch (e) {
      setToast(e.message || "Could not load chats.");
    }
    setLoading(false);
  }, [session.id, setToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (initialChatId) {
      setActiveChatId(initialChatId);
      onConsumedInitialChat?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChatId]);

  if (activeChatId) {
    return <ChatThread chatId={activeChatId} session={session} onClose={() => { setActiveChatId(null); loadAll(); }} setToast={setToast} />;
  }

  if (loading) return <CenteredNote>Loading chats…</CenteredNote>;

  return (
    <div>
      {chats.length === 0 && <CenteredNote>No active chats yet. Chats unlock once a bid is accepted.</CenteredNote>}
      <div style={{ display: "grid", gap: 10 }}>
        {chats.map(c => {
          const other = session.role === "customer" ? c.businessName : c.customerName;
          return (
            <button key={c.id} onClick={() => setActiveChatId(c.id)} style={{
              background: C.paper, border: `1px solid ${C.line}`, borderRadius: 18, padding: 14, boxShadow: SHADOW,
              display: "flex", gap: 12, alignItems: "center", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
            }}>
              <Avatar emoji={session.role === "customer" ? "🚛" : "👤"} bg={session.role === "customer" ? C.tealLight : C.sandWarm} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {c.unread && <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.ember, flexShrink: 0 }} />}
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{other}</div>
                </div>
                <div style={{ fontSize: 12, color: C.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.jobTitle}</div>
                {c.lastMessagePreview && (
                  <div style={{ fontSize: 11.5, color: C.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
                    {c.lastMessagePreview}
                  </div>
                )}
              </div>
              <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.teal, flexShrink: 0 }}>${c.bid_amount}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
