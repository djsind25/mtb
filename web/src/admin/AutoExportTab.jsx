import { useEffect, useState } from "react";
import { C } from "../theme";
import { Btn, CenteredNote } from "../ui/Primitives";
import { loadAutoExportEnabled, setAutoExportEnabled, sendMonthlyExportNow } from "./data";

export function AutoExportTab({ session, setToast }) {
  const [enabled, setEnabled] = useState(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAutoExportEnabled().then(v => { if (!cancelled) setEnabled(v); }).catch(() => setEnabled(false));
    return () => { cancelled = true; };
  }, []);

  async function toggle(next) {
    setSaving(true);
    try {
      await setAutoExportEnabled(next);
      setEnabled(next);
      setToast(next ? "Auto export turned on." : "Auto export turned off.");
    } catch (e) {
      setToast(e.message || "Could not update this setting.");
    }
    setSaving(false);
  }

  async function sendNow() {
    setSending(true);
    try {
      await sendMonthlyExportNow();
      setToast("Export sent — check the super admin's inbox.");
    } catch (e) {
      setToast(e.message || "Could not send the export.");
    }
    setSending(false);
  }

  if (enabled === null) return <CenteredNote>Loading…</CenteredNote>;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 16, lineHeight: 1.6 }}>
        On the 1st of each month, MyTrashBid emails the super admin a summary of last month's
        revenue (booked jobs, GMV, deposit revenue, hauler-direct payout) and a CSV listing every
        job completed that month — the same figures as the Revenue tab, sent automatically for
        tax and bookkeeping records.
      </p>

      <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 700, color: C.pineDeep, cursor: session.superAdmin ? "pointer" : "default" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!session.superAdmin || saving}
            onChange={e => toggle(e.target.checked)}
          />
          Auto export {enabled ? "on" : "off"}
        </label>
        {!session.superAdmin && (
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 8 }}>Only the super admin can turn this on or off.</div>
        )}
      </div>

      {session.superAdmin && (
        <Btn size="sm" full={false} onClick={sendNow} disabled={sending}>
          {sending ? "Sending…" : "Send test export now"}
        </Btn>
      )}
    </div>
  );
}
