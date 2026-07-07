import { C } from "../theme";

export function OverdueJobRow({ job, expanded }) {
  const daysSince = job.accepted_at ? Math.floor((Date.now() - new Date(job.accepted_at).getTime()) / (24 * 60 * 60 * 1000)) : null;
  return (
    <div style={{ border: `1px solid ${C.red}55`, background: C.redLight, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.red }}>⚠ {job.title}</span>
        <span style={{ fontSize: 10.5, color: C.gray }}>{daysSince} days since booked</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray }}>
        Customer: {job.customerName || "—"} · Hauler: {job.bid?.businessName || "—"} · Bid: ${job.bid?.amount ?? "—"}
      </div>
      {expanded && (
        <div style={{ fontSize: 11.5, color: "#8B3A30", marginTop: 6, lineHeight: 1.5 }}>
          Hauler has not confirmed completion past the 30-day window. They've received an in-app reminder. The ${job.bid ? (job.bid.amount * 0.1).toFixed(2) : "—"} deposit was already collected at booking; confirmation just closes out the job and unlocks reviews. Consider reaching out directly.
        </div>
      )}
    </div>
  );
}
