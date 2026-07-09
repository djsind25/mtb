import { useState } from "react";
import { C, expiryLabel, isExpired } from "../theme";
import { Badge, Btn, CenteredNote } from "../ui/Primitives";
import { BidRow } from "./BidRow";
import { JobPhotos } from "./JobPhotos";

export function CustomerJobCard({ job, completedCount, onAccepted, onOpenChat, onRenewJob, setToast }) {
  const [expanded, setExpanded] = useState(false);
  const bids = job.bids || [];
  const jobExpired = job.status === "open" && isExpired(job.expires_at);

  const tally = completedCount != null && bids.length > 0 && (
    <div style={{ fontSize: 12, color: C.pineDeep, background: C.tealLight, borderRadius: 8, padding: "8px 11px", marginBottom: 12, display: "flex", alignItems: "center", gap: 7 }}>
      <span>🎉</span>
      <span><strong>{completedCount.toLocaleString()}</strong> job{completedCount === 1 ? "" : "s"} completed on MyTrashBid — compare your quotes below.</span>
    </div>
  );

  return (
    <div style={{ background: C.paper, border: `1px solid ${jobExpired ? C.amber + "66" : C.line}`, borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => setExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", padding: 16, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14.5, color: C.pineDeep, marginBottom: 4 }}>{job.title}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Badge color={job.status === "open" ? C.ember : C.teal} bg={job.status === "open" ? C.emberLight : C.tealLight}>
                {job.status === "open" ? `${bids.length} bid${bids.length !== 1 ? "s" : ""}` : "Booked"}
              </Badge>
              {job.status === "open" && (
                <Badge color={jobExpired ? C.red : C.gray} bg={jobExpired ? C.redLight : C.grayLight}>
                  {expiryLabel(job.expires_at)}
                </Badge>
              )}
            </div>
          </div>
          <span style={{ color: C.gray }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: 16 }}>
          <JobPhotos jobId={job.id} />
          {job.status === "booked" ? (
            <div>
              <div style={{ fontSize: 13, color: C.teal, fontWeight: 700, marginBottom: 6 }}>✓ Locked in — deposit paid</div>
              <div style={{ marginBottom: 10 }}>
                {job.completed ? (
                  <Badge color={C.teal} bg={C.tealLight}>✓ Hauler confirmed complete — leave a review in chat</Badge>
                ) : (
                  <Badge color={C.gray} bg={C.grayLight}>Pay the balance directly to your hauler at completion</Badge>
                )}
              </div>
              <Btn variant="teal" onClick={() => onOpenChat(job.chatId)}>Open chat</Btn>
            </div>
          ) : jobExpired ? (
            <div>
              <div style={{ fontSize: 13, color: C.red, fontWeight: 600, marginBottom: 12 }}>
                ⚠ This job listing expired 14 days after posting and is no longer visible to haulers for new bids.
                {bids.length > 0 && " Bids already placed below may still be accepted if they haven't expired themselves."}
              </div>
              <Btn variant="dark" onClick={() => onRenewJob(job.id)}>Renew job listing — 14 more days</Btn>
              {bids.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  {tally}
                  <div style={{ display: "grid", gap: 10 }}>
                    {bids.map(bid => <BidRow key={bid.id} bid={bid} jobId={job.id} onAccepted={onAccepted} setToast={setToast} />)}
                  </div>
                </div>
              )}
            </div>
          ) : bids.length === 0 ? (
            <CenteredNote>Waiting on bids — most jobs get their first one within 24 hours. This listing stays live for 14 days.</CenteredNote>
          ) : (
            <div>
              {tally}
              <div style={{ display: "grid", gap: 10 }}>
                {bids.map(bid => <BidRow key={bid.id} bid={bid} jobId={job.id} onAccepted={onAccepted} setToast={setToast} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
