import { C } from "../theme";
import { TOS_URL, PRIVACY_URL } from "../legal/legalContent";

// The full text lives at TOS_URL/PRIVACY_URL (site/terms.html, site/privacy.html) — not
// duplicated here, so there's exactly one place to edit when the wording changes.
export function TermsAgreement({ checked, onChange, monitoringChecked, onMonitoringChange }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: C.ink, cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          I agree to the{" "}
          <a href={TOS_URL} target="_blank" rel="noopener noreferrer" style={{ color: C.teal, textDecoration: "underline" }}>Terms of Service</a>
          , including the platform abuse and account suspension policy, and I have read the{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ color: C.teal, textDecoration: "underline" }}>Privacy Policy</a>.
        </span>
      </label>

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: C.ink, cursor: "pointer", marginTop: 10 }}>
        <input type="checkbox" checked={monitoringChecked} onChange={e => onMonitoringChange(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I acknowledge that chats are actively monitored, and that hauler business names are hidden until a bid is accepted.</span>
      </label>

      <div style={{ marginTop: 8, background: C.sand, border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", fontSize: 11.5, color: C.gray, lineHeight: 1.55 }}>
        🔒 Heads up: to keep jobs and payments safe on MyTrashBid, in-app chats are monitored in
        real time and phone numbers and email addresses are automatically hidden in messages.
        Learn more in our{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ color: C.teal }}>Privacy Policy</a>.
      </div>
    </div>
  );
}
