import { useEffect, useState } from "react";
import { serif, C, mono } from "../theme";
import { Avatar, CenteredNote } from "../ui/Primitives";
import { loadMyChats } from "./data";

export function ChatsListPage({ session, onOpenChat }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadMyChats(session.id).then(c => { if (!cancelled) { setChats(c); setLoading(false); } });
    return () => { cancelled = true; };
  }, [session.id]);

  if (loading) return <CenteredNote>Loading chats…</CenteredNote>;

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      <h2 style={{ fontFamily: serif, fontSize: 22, color: C.pineDeep, marginBottom: 16 }}>Your chats</h2>
      {chats.length === 0 && <CenteredNote>No active chats yet. Chats unlock once a bid is accepted.</CenteredNote>}
      <div style={{ display: "grid", gap: 10 }}>
        {chats.map(c => {
          const other = session.role === "customer" ? c.businessName : c.customerName;
          return (
            <button key={c.id} onClick={() => onOpenChat(c.id)} style={{
              background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14,
              display: "flex", gap: 12, alignItems: "center", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
            }}>
              <Avatar emoji={session.role === "customer" ? "🚛" : "👤"} bg={session.role === "customer" ? C.tealLight : C.sandWarm} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{other}</div>
                <div style={{ fontSize: 12, color: C.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.jobTitle}</div>
              </div>
              <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.teal }}>${c.bid_amount}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
