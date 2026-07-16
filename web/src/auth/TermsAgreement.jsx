import { useState } from "react";
import { C } from "../theme";

export function TermsAgreement({ checked, onChange }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: C.ink, cursor: "pointer" }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          I agree to the{" "}
          <button type="button" onClick={(e) => { e.preventDefault(); setExpanded(x => !x); }} style={{
            background: "none", border: "none", padding: 0, color: C.pine, textDecoration: "underline", cursor: "pointer", fontSize: "inherit", fontFamily: "inherit",
          }}>Terms of Service</button>
          , including the platform abuse and account suspension policy.
        </span>
      </label>

      {expanded && (
        <div style={{ marginTop: 8, background: C.sandWarm, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", fontSize: 11.5, color: C.gray, lineHeight: 1.6, maxHeight: 220, overflowY: "auto" }}>
          <strong style={{ color: C.ink, display: "block", marginBottom: 6 }}>MyTrashBid Terms of Service (summary)</strong>
          <p style={{ margin: "0 0 8px" }}>
            MyTrashBid connects customers with independent local haulers. Customers post jobs and
            review bids; accepting a bid charges a 10% deposit through MyTrashBid, and the
            remaining balance is settled directly between customer and hauler. Chats between
            matched users are monitored to keep the marketplace fair.
          </p>
          <strong style={{ color: C.ink, display: "block", marginBottom: 4 }}>Platform abuse &amp; account suspension</strong>
          <p style={{ margin: "0 0 6px" }}>The following are prohibited and may result in a warning, suspension, or permanent deactivation of your account, at MyTrashBid's discretion:</p>
          <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
            <li>Sharing contact or payment info to arrange a job off-platform to avoid the deposit</li>
            <li>Harassing, threatening, or abusive communication toward another user</li>
            <li>Posting fraudulent jobs, fake bids, or manipulating reviews</li>
            <li>Repeated no-shows or failure to complete a confirmed, accepted job</li>
          </ul>
          <p style={{ margin: 0 }}>
            Deposits already collected are non-refundable where an account is suspended for cause.
            This summary is not a substitute for the full Terms of Service and Privacy Policy.
          </p>
        </div>
      )}
    </div>
  );
}
