import { C } from "../theme";
import { nowStr } from "../theme";

export function FlagRow({ flag, expanded }) {
  const isRepeat = flag.flag_type === "warned-repeat";
  return (
    <div style={{ border: `1px solid ${isRepeat ? C.red : C.amber}55`, background: isRepeat ? C.redLight : C.amberLight, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: isRepeat ? C.red : "#8A6604" }}>
          {isRepeat ? "🚩 Repeat offense" : "🛡️ First flag"} — {flag.senderName || "Unknown"} ({flag.sender_role})
        </span>
        <span style={{ fontSize: 10.5, color: C.gray }}>{nowStr(flag.created_at)}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 4 }}>Job: {flag.jobTitle || "—"}</div>
      {expanded && <div style={{ fontSize: 13, color: C.ink, background: C.paper, borderRadius: 8, padding: "8px 10px" }}>"{flag.text}"</div>}
    </div>
  );
}
