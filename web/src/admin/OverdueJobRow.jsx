import { useState } from "react";
import { C } from "../theme";
import { setOverdueReviewed } from "./data";

export function OverdueJobRow({ job, expanded, onChanged }) {
  const [working, setWorking] = useState(false);
  const reviewed = !!job.overdue_reviewed;
  const daysSince = job.accepted_at ? Math.floor((Date.now() - new Date(job.accepted_at).getTime()) / (24 * 60 * 60 * 1000)) : null;

  async function toggleReviewed(e) {
    const next = e.target.checked;
    setWorking(true);
    try {
      await setOverdueReviewed(job.id, next);
      onChanged?.();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div style={{
      border: `1px solid ${reviewed ? C.line : C.red + "55"}`,
      background: reviewed ? C.paper : C.redLight,
      borderRadius: 10, padding: "10px 12px", opacity: reviewed ? 0.65 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: reviewed ? C.gray : C.red }}>⚠ {job.title}</span>
        <span style={{ fontSize: 10.5, color: C.gray, whiteSpace: "nowrap" }}>{daysSince} days since booked</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray }}>
        Customer: {job.customerName || "—"} · Hauler: {job.bid?.businessName || "—"} · Bid: ${job.bid?.amount ?? "—"}
      </div>
      {expanded && (
        <div style={{ fontSize: 11.5, color: "#8B3A30", marginTop: 6, lineHeight: 1.5 }}>
          Hauler has not confirmed completion past the 30-day window. They've received an in-app reminder. The ${job.bid ? (job.bid.amount * 0.1).toFixed(2) : "—"} deposit was already collected at booking; confirmation just closes out the job and unlocks reviews. Consider reaching out directly.
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.ink, cursor: "pointer" }}>
          <input type="checkbox" checked={reviewed} disabled={working} onChange={toggleReviewed} />
          Reviewed
        </label>
      </div>
    </div>
  );
}
