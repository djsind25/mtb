import { useState } from "react";
import { C, sans, nowStr, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { AdminChatViewer } from "./AdminChatViewer";
import { UserLink } from "./UserLink";

function Row({ chat, onViewUser }) {
  const [viewingChat, setViewingChat] = useState(false);
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.red}55`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{chat.jobTitle || "Job"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            <UserLink id={chat.customer_id} name={chat.customerName} onViewUser={onViewUser} /> ↔{" "}
            <UserLink id={chat.hauler_id} name={chat.haulerName} onViewUser={onViewUser} /> · ZIP {chat.zip || "—"}
          </div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>Stalled since {nowStr(chat.stalled_at)}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${Number(chat.bid_amount).toFixed(2)}</div>
          <div style={{ fontSize: 10.5, color: C.gray }}>accepted bid</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Badge color={C.red} bg={C.redLight}>🚩 No service date locked</Badge>
        <Btn size="sm" full={false} variant="teal" onClick={() => setViewingChat(true)}>💬 View conversation</Btn>
      </div>
      {viewingChat && <AdminChatViewer chatId={chat.id} onClose={() => setViewingChat(false)} />}
    </div>
  );
}

export function StalledJobsTab({ chats, onViewUser }) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {chats.length === 0 && <div style={{ fontSize: 13, color: C.gray, textAlign: "center", padding: 24 }}>No stalled jobs right now.</div>}
      {chats.map(c => <Row key={c.id} chat={c} onViewUser={onViewUser} />)}
    </div>
  );
}
