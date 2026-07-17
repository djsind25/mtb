import { useState } from "react";
import { C } from "../theme";

export function SmsAgreement({ checked, onChange }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: C.ink, cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          Send me text message updates (optional).{" "}
          <button type="button" onClick={(e) => { e.preventDefault(); setExpanded(x => !x); }} style={{
            background: "none", border: "none", padding: 0, color: C.teal, textDecoration: "underline", cursor: "pointer", fontSize: "inherit", fontFamily: "inherit",
          }}>Details</button>
        </span>
      </label>

      {expanded && (
        <div style={{ marginTop: 8, background: C.sand, border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 14px", fontSize: 11.5, color: C.gray, lineHeight: 1.6 }}>
          By checking this box, you agree to receive automated text messages from MyTrashBid
          (e.g. new job alerts, bid updates, chat messages) at the phone number provided. Consent
          is not a condition of using MyTrashBid. Message frequency varies. Message and data rates
          may apply. Reply STOP to unsubscribe at any time, or update your preferences from your
          Account tab.
        </div>
      )}
    </div>
  );
}
