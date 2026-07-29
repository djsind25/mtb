import { useState } from "react";
import { C, sans, expiryLabel, isExpired, timelineMeta } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { AdminChatViewer } from "./AdminChatViewer";
import { JobQuestions } from "../jobs/JobQuestions";
import { JobUpdates } from "../jobs/JobUpdates";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Mirrors ChatThread's moneyState logic — a full-mode job with none of the coordination/lock
// columns set predates the scheduling rework (charged in full at accept, under the old flow).
function schedulingState(s) {
  if (!s || s.paymentMode !== "full") return null;
  const hasScheduling = !!(s.coordinationDeadline || s.coordinationExtendedAt || s.stalledAt || s.lockedServiceDate);
  if (!hasScheduling) return { label: "Legacy — charged in full at accept", color: C.gray, bg: C.grayLight };
  if (s.capturedAt) return { label: "Captured", color: C.teal, bg: C.tealLight };
  if (s.authorizedAt) return { label: "Authorized & held", color: C.teal, bg: C.tealLight };
  if (s.lockedServiceDate) return { label: "Scheduled", color: C.gray, bg: C.grayLight };
  if (s.stalledAt) return { label: "Stalled", color: C.red, bg: C.redLight };
  if (s.coordinationExtendedAt) return { label: "Coordinating (nudged)", color: C.amber, bg: C.amberLight };
  return { label: "Coordinating", color: C.gray, bg: C.grayLight };
}

export function JobRow({ job }) {
  const timeline = timelineMeta(job.timeline);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
      <span style={{ color: C.ink, fontWeight: 600 }}>{job.title}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {timeline && <Badge color={timeline.color} bg={timeline.bg}>{timeline.label}</Badge>}
        <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
      </div>
    </div>
  );
}

export function JobRowExpanded({ job }) {
  const [open, setOpen] = useState(false);
  const [viewingChat, setViewingChat] = useState(false);
  const jobExpired = job.status === "open" && isExpired(job.expires_at);
  const timeline = timelineMeta(job.timeline);
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", background: "none", border: "none", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: "inherit" }}>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{job.title}</div>
          <div style={{ fontSize: 11, color: C.gray }}>by {job.customerName || "—"} · ZIP {job.zip} · {(job.bids || []).length} bids</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {timeline && <Badge color={timeline.color} bg={timeline.bg}>{timeline.label}</Badge>}
          {job.status === "open" && <Badge color={jobExpired ? C.red : C.gray} bg={jobExpired ? C.redLight : C.grayLight}>{expiryLabel(job.expires_at)}</Badge>}
          <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
        </div>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 14px" }}>
          <JobUpdates jobId={job.id} viewerRole="admin" jobOpen={job.status === "open" && !jobExpired} />
          <JobQuestions jobId={job.id} viewerRole="admin" jobOpen={job.status === "open" && !jobExpired} />
          {job.status === "booked" && job.chatId && (
            <div style={{ marginBottom: 10 }}>
              <Btn size="sm" full={false} variant="teal" onClick={() => setViewingChat(true)}>💬 View conversation</Btn>
            </div>
          )}
          {job.status === "booked" && job.scheduling && schedulingState(job.scheduling) && (
            <div style={{ background: C.sand, borderRadius: 8, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: job.scheduling.lockedServiceDate ? 4 : 0 }}>
                <span style={{ fontWeight: 700, color: C.pineDeep }}>Scheduling:</span>
                <Badge color={schedulingState(job.scheduling).color} bg={schedulingState(job.scheduling).bg}>{schedulingState(job.scheduling).label}</Badge>
              </div>
              {job.scheduling.lockedServiceDate && (
                <div style={{ color: C.gray }}>
                  {formatDate(job.scheduling.lockedServiceDate)} · ${job.scheduling.lockedFinalPrice}
                  {job.scheduling.proposedByRole && ` — proposed by the ${job.scheduling.proposedByRole}`}
                  {job.scheduling.confirmedByName && `, confirmed by ${job.scheduling.confirmedByName}`}
                </div>
              )}
            </div>
          )}
          {(job.bids || []).length === 0 && <div style={{ fontSize: 12, color: C.gray }}>No bids yet.</div>}
          {(job.bids || []).map(b => (
            <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
              <span>{b.businessName} {b.id === job.accepted_bid_id && <Badge color={C.teal} bg={C.tealLight}>Won</Badge>} {job.status === "open" && <Badge color={isExpired(b.expires_at) ? C.red : C.gray} bg={isExpired(b.expires_at) ? C.redLight : C.grayLight}>{expiryLabel(b.expires_at)}</Badge>}</span>
              <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>${b.amount} <span style={{ color: C.gray, fontWeight: 400 }}>(${(b.amount * 0.1).toFixed(2)} deposit)</span></span>
            </div>
          ))}
        </div>
      )}
      {viewingChat && <AdminChatViewer chatId={job.chatId} onClose={() => setViewingChat(false)} />}
    </div>
  );
}
