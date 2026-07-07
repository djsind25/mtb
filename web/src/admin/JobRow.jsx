import { useState } from "react";
import { C, mono, expiryLabel, isExpired } from "../theme";
import { Badge } from "../ui/Primitives";

export function JobRow({ job }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
      <span style={{ color: C.ink, fontWeight: 600 }}>{job.title}</span>
      <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
    </div>
  );
}

export function JobRowExpanded({ job }) {
  const [open, setOpen] = useState(false);
  const jobExpired = job.status === "open" && isExpired(job.expires_at);
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", background: "none", border: "none", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit" }}>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{job.title}</div>
          <div style={{ fontSize: 11, color: C.gray }}>by {job.customerName || "—"} · ZIP {job.zip} · {(job.bids || []).length} bids</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {job.status === "open" && <Badge color={jobExpired ? C.red : C.gray} bg={jobExpired ? C.redLight : C.grayLight}>{expiryLabel(job.expires_at)}</Badge>}
          <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
        </div>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 14px" }}>
          {(job.bids || []).length === 0 && <div style={{ fontSize: 12, color: C.gray }}>No bids yet.</div>}
          {(job.bids || []).map(b => (
            <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
              <span>{b.businessName} {b.id === job.accepted_bid_id && <Badge color={C.teal} bg={C.tealLight}>Won</Badge>} {job.status === "open" && <Badge color={isExpired(b.expires_at) ? C.red : C.gray} bg={isExpired(b.expires_at) ? C.redLight : C.grayLight}>{expiryLabel(b.expires_at)}</Badge>}</span>
              <span style={{ fontFamily: mono, fontWeight: 700 }}>${b.amount} <span style={{ color: C.gray, fontWeight: 400 }}>(${(b.amount * 0.1).toFixed(2)} deposit)</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
