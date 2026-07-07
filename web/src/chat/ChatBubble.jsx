import { C } from "../theme";
import { Avatar } from "../ui/Primitives";
import { nowStr } from "../theme";

export function ChatBubble({ msg, viewer }) {
  if (msg.sender_role === "system") {
    return <div style={{ textAlign: "center", margin: "12px 0" }}><span style={{ fontSize: 11, color: C.teal, background: C.tealLight, borderRadius: 20, padding: "5px 12px", fontWeight: 600 }}>✓ {msg.text}</span></div>;
  }
  const isSelf = msg.sender_role === viewer;
  const isCustomer = msg.sender_role === "customer";
  const isWarned = msg.flag_type === "warned" || msg.flag_type === "warned-repeat";
  const isRepeat = msg.flag_type === "warned-repeat";
  return (
    <div style={{ display: "flex", justifyContent: isSelf ? "flex-end" : "flex-start", margin: "4px 14px", gap: 8 }}>
      {!isSelf && <Avatar emoji={isCustomer ? "👤" : "🚛"} size={26} bg={isCustomer ? C.sandWarm : C.tealLight} />}
      <div style={{ maxWidth: "74%" }}>
        <div style={{
          background: isSelf ? (isRepeat ? "#7A2E25" : C.pine) : (isRepeat ? C.redLight : C.paper),
          color: isSelf ? C.paper : C.ink,
          border: isWarned ? `1.5px solid ${isRepeat ? C.red : C.amber}` : (isSelf ? "none" : `1px solid ${C.line}`),
          borderRadius: 16, borderBottomRightRadius: isSelf ? 4 : 16, borderBottomLeftRadius: isSelf ? 16 : 4,
          padding: "9px 13px", fontSize: 13.5, lineHeight: 1.5,
        }}>{msg.text}</div>
        {isWarned && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, justifyContent: isSelf ? "flex-end" : "flex-start" }}>
            <span style={{ fontSize: 10 }}>{isRepeat ? "🚩" : "🛡️"}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: isRepeat ? C.red : "#8A6604" }}>
              {isRepeat ? "Repeated attempt — flagged for Trust & Safety review" : "Flagged for sharing contact/payment info off-platform"}
            </span>
          </div>
        )}
        <div style={{ fontSize: 10, color: C.gray, marginTop: 2, textAlign: isSelf ? "right" : "left" }}>{nowStr(msg.created_at)}</div>
      </div>
    </div>
  );
}
