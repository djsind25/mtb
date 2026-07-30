import { C } from "../theme";
import { Avatar } from "../ui/Primitives";
import { nowStr } from "../theme";

const ROLE_LABEL = { customer: "Customer", hauler: "Hauler", admin: "Support" };

// viewer is "customer" | "hauler" | "admin" — which side is looking at this thread. viewerId
// disambiguates admin-authored messages: with a job chat now allowing more than one admin to
// join over time, "is this my own message" for an admin viewer means sender_id match, not just a
// role match (unlike customer/hauler, where there's only ever one of each on the chat).
export function ChatBubble({ msg, viewer, viewerId }) {
  if (msg.sender_role === "system") {
    return <div style={{ textAlign: "center", margin: "12px 0" }}><span style={{ fontSize: 11, color: C.teal, background: C.tealLight, borderRadius: 20, padding: "5px 12px", fontWeight: 600 }}>✓ {msg.text}</span></div>;
  }
  // Defense in depth — messages_select RLS already guarantees a customer/hauler viewer never
  // receives a staff_only row in the first place, so this should never actually trigger.
  if (msg.visibility === "staff_only" && viewer !== "admin") return null;

  const isSelf = viewer === "admin" ? msg.sender_id === viewerId : msg.sender_role === viewer;
  const isCustomer = msg.sender_role === "customer";
  const isAdmin = msg.sender_role === "admin";
  const isStaffNote = msg.visibility === "staff_only";
  const isWarned = msg.flag_type === "warned" || msg.flag_type === "warned-repeat";
  const isRepeat = msg.flag_type === "warned-repeat";
  const avatarEmoji = isAdmin ? "🛡️" : isCustomer ? "👤" : "🚛";
  const avatarBg = isAdmin ? C.slateLight : isCustomer ? C.sandWarm : C.tealLight;

  return (
    <div style={{ display: "flex", justifyContent: isSelf ? "flex-end" : "flex-start", margin: "4px 14px", gap: 8 }}>
      {!isSelf && <Avatar emoji={avatarEmoji} size={26} bg={avatarBg} />}
      <div style={{ maxWidth: "74%" }}>
        {!isSelf && (
          <div style={{ fontSize: 10.5, fontWeight: 700, color: isAdmin ? C.slate : C.gray, marginBottom: 2 }}>
            {ROLE_LABEL[msg.sender_role]}
          </div>
        )}
        <div style={{
          background: isStaffNote ? C.slateLight : isSelf ? (isRepeat ? "#7A2E25" : C.pine) : (isRepeat ? C.redLight : C.paper),
          color: isStaffNote ? C.slate : isSelf ? C.paper : C.ink,
          border: isStaffNote ? `1.5px dashed ${C.slate}88` : isWarned ? `1.5px solid ${isRepeat ? C.red : C.amber}` : (isSelf ? "none" : `1px solid ${C.line}`),
          borderRadius: 16, borderBottomRightRadius: isSelf ? 4 : 16, borderBottomLeftRadius: isSelf ? 16 : 4,
          padding: "9px 13px", fontSize: 13.5, lineHeight: 1.5,
        }}>
          {isStaffNote && <div style={{ fontSize: 10, fontWeight: 700, marginBottom: 3 }}>🔒 Staff note — visible to admins only</div>}
          {msg.text}
        </div>
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
