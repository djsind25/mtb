import { C, nowStr } from "../theme";
import { Badge } from "../ui/Primitives";

export function SupportChatRow({ chat, onOpen }) {
  return (
    <button onClick={() => onOpen(chat.id)} style={{
      width: "100%", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12,
      display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.pineDeep }}>{chat.requesterName || chat.sender_email || "Unknown"}</span>
          <Badge color={C.gray} bg={C.grayLight}>{chat.requesterRole || "guest"}</Badge>
          {chat.status === "closed" && <Badge color={C.red} bg={C.redLight}>closed</Badge>}
        </div>
        {chat.lastMessagePreview && (
          <div style={{ fontSize: 12, color: C.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 400 }}>
            {chat.lastMessagePreview}
          </div>
        )}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 10 }}>
        {chat.assignedAdminName && <div style={{ fontSize: 10.5, color: C.teal, fontWeight: 600 }}>Handling: {chat.assignedAdminName}</div>}
        <div style={{ fontSize: 10.5, color: C.gray }}>{nowStr(chat.lastMessageAt || chat.created_at)}</div>
      </div>
    </button>
  );
}
