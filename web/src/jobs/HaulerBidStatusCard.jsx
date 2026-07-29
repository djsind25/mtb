import { useCallback, useEffect, useRef, useState } from "react";
import { C, sans, expiryLabel, isExpired, daysLeft, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { CompletionPhotos } from "./CompletionPhotos";
import { JobPhotos } from "./JobPhotos";
import { JobQuestions } from "./JobQuestions";
import { JobUpdates } from "./JobUpdates";
import { RequestCancellationControl } from "./RequestCancellationControl";
import { ProposeBidRevisionControl } from "./ProposeBidRevisionControl";
import { ScheduleProposal } from "./ScheduleProposal";
import { ReviewPanel } from "../chat/ReviewPanel";

export function HaulerBidStatusCard({ job, session, changeOrdersEnabled, onOpenChat, onRenewBid, onMarkDone, onCancellationChanged, onRevisionProposed, onScheduleChanged, setToast, highlighted = false }) {
  const myBid = job.myBid;
  const won = job.status === "booked" && job.accepted_bid_id === myBid?.id;
  const lost = job.status === "booked" && job.accepted_bid_id !== myBid?.id;
  const cancelled = job.status === "cancelled" && job.accepted_bid_id === myBid?.id;
  const pending = (!job.status || job.status === "open");
  const bidExpired = pending && isExpired(myBid?.expires_at);

  const completionOverdue = won && !job.completed && !job.haulerDoneAt && isExpired(job.complete_by);
  const completionDaysLeft = won && !job.completed && !job.haulerDoneAt ? daysLeft(job.complete_by) : null;
  const isFull = job.payment_mode === "full";

  const [counts, setCounts] = useState({ before: 0, after: 0 });
  const [marking, setMarking] = useState(false);
  const [showQna, setShowQna] = useState(false);
  const canMarkDone = counts.before > 0 && counts.after > 0;
  const cardRef = useRef(null);

  // Deep-link target from Total Earned — scroll this card into view once when it's the one
  // being landed on. highlighted itself auto-clears on a timer in HaulerDashboard.
  useEffect(() => {
    if (highlighted) cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  // Must be stable across renders: CompletionPhotos' reload() is a useCallback depending on
  // this prop, feeding a useEffect keyed on reload's identity. A fresh inline function here
  // every render would recreate reload every render, re-firing that effect every render — each
  // firing calls this, which calls setCounts, which re-renders this component, which recreates
  // the inline function again — an unbroken fetch/render loop.
  const handlePhotosChanged = useCallback((p) => {
    setCounts({ before: p.filter(x => x.phase === "before").length, after: p.filter(x => x.phase === "after").length });
  }, []);

  async function markDone() {
    setMarking(true);
    try {
      await onMarkDone(job.id);
    } catch (e) {
      setToast?.(e.message || "Could not mark complete.");
    }
    setMarking(false);
  }

  return (
    <div ref={cardRef} style={{
      background: C.paper, borderRadius: RADIUS.md, padding: 14, transition: "box-shadow 0.3s",
      border: `1px solid ${highlighted ? C.teal : bidExpired || completionOverdue ? C.amber + "66" : C.line}`,
      boxShadow: highlighted ? `0 0 0 3px ${C.teal}33` : SHADOW_SM,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{job.title}</span>
        <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.teal }}>${myBid?.amount}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 6 }}>
        📍 ZIP {job.zip}{job.city ? ` · ${job.city}, ${job.state}` : ""} · {job.bid_count} bid{job.bid_count !== 1 ? "s" : ""} on this job
      </div>
      {job.description && <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 10, lineHeight: 1.5 }}>{job.description}</p>}
      {/* Same album the customer can add to from chat mid-conversation — this card never showed
          it before, so anything added post-booking was invisible from "My Bids". */}
      <JobPhotos jobId={job.id} />
      {/* Once a job books it drops out of Browse Jobs entirely, so this is the only place a
          winning hauler can still see the Q&A/updates history — read-only once not open. Uses
          the job's own expiry (matching job_is_open_for_bid, the real server-side gate), not the
          bid's separate expiry — those are two different clocks. Collapsed by default (unlike
          Browse Jobs, this card has no card-level collapse of its own to hide behind). */}
      <button onClick={() => setShowQna(s => !s)} style={{
        background: "none", border: "none", padding: 0, marginBottom: showQna ? 8 : 4,
        color: C.teal, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
      }}>
        Questions & updates {showQna ? "▲" : "▼"}
      </button>
      {showQna && (
        <>
          <JobUpdates jobId={job.id} viewerRole="hauler" jobOpen={job.status === "open" && !isExpired(job.expires_at)} setToast={setToast} />
          <JobQuestions jobId={job.id} viewerRole="hauler" haulerId={session.id} jobOpen={job.status === "open" && !isExpired(job.expires_at)} eligible={session.licenseActive && session.insuranceActive} setToast={setToast} />
        </>
      )}
      {won && (
        <div style={{ fontSize: 11, color: C.gray, marginBottom: 8 }}>
          {isFull ? (
            // Prefers the renegotiated locked_final_price over the original bid once a
            // ScheduleProposal has locked one in — myBid.amount is the accept-time snapshot and
            // is deliberately never rewritten (append-only), so it goes stale the moment a
            // schedule with a different final price is confirmed.
            <>You'll receive <strong style={{ color: C.pineDeep }}>${((job.lockedFinalPrice ?? myBid.amount) * 0.9).toFixed(2)}</strong> (90% after the platform fee) once the job is confirmed complete by both you and the customer.</>
          ) : (
            <>You collect <strong style={{ color: C.pineDeep }}>${(myBid.amount * 0.9).toFixed(2)}</strong> (90% after the platform fee).</>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {won && job.completed && <Badge color={C.teal} bg={C.tealLight}>✓ Job complete</Badge>}
        {won && !job.completed && job.haulerDoneAt && <Badge color={C.amber} bg={C.amberLight}>Awaiting customer acknowledgment</Badge>}
        {won && !job.completed && !job.haulerDoneAt && <Badge color={C.teal} bg={C.tealLight}>✓ You won this job</Badge>}
        {lost && <Badge color={C.gray} bg={C.grayLight}>{job.wasAccepted ? "Customer switched to another hauler" : "Customer chose another hauler"}</Badge>}
        {cancelled && <Badge color={C.gray} bg={C.grayLight}>Cancelled by MyTrashBid</Badge>}
        {pending && !bidExpired && <Badge color={C.ember} bg={C.emberLight}>Pending — awaiting customer decision</Badge>}
        {bidExpired && <Badge color={C.red} bg={C.redLight}>Bid expired — no longer acceptable</Badge>}
        {pending && <Badge color={C.gray} bg={C.grayLight}>{expiryLabel(myBid?.expires_at)}</Badge>}
        {won && !job.completed && !job.haulerDoneAt && !completionOverdue && <Badge color={C.gray} bg={C.grayLight}>Complete within {completionDaysLeft} day{completionDaysLeft !== 1 ? "s" : ""}</Badge>}
        {completionOverdue && <Badge color={C.red} bg={C.redLight}>⚠ 30-day window passed</Badge>}
      </div>

      {bidExpired && (
        <Btn size="sm" variant="dark" onClick={() => onRenewBid(myBid.id)}>Renew bid — 14 more days</Btn>
      )}

      {won && !job.completed && (
        <ScheduleProposal job={job} viewerRole="hauler" viewerId={session.id} defaultPrice={myBid?.amount} onChanged={onScheduleChanged} setToast={setToast} />
      )}

      {won && (
        <>
          {/* Not done yet: hauler uploads geotagged before/after photos, then marks the work complete. */}
          {!job.completed && !job.haulerDoneAt && (
            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Complete this job</div>
              <CompletionPhotos jobId={job.id} haulerId={session.id} onChange={handlePhotosChanged} setToast={setToast} />
            </div>
          )}
          {/* Marked done, waiting on the customer: show the submitted photos read-only. */}
          {!job.completed && job.haulerDoneAt && (
            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 12, marginBottom: 4 }}>
              <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 8 }}>
                You marked this complete. Waiting on the customer to acknowledge — it auto-confirms after 7 days if they don't respond.
              </div>
              <CompletionPhotos jobId={job.id} />
            </div>
          )}
          {/* Fully complete: photos stay editable (haulerId still passed) in case one more shot is
              needed later, and the review lives right here instead of only inside chat. */}
          {job.completed && (
            <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 12, marginBottom: 4 }}>
              <CompletionPhotos jobId={job.id} haulerId={session.id} onChange={handlePhotosChanged} setToast={setToast} />
              <div style={{ borderRadius: RADIUS.md, overflow: "hidden", marginTop: 10 }}>
                <ReviewPanel chat={{ customerName: job.customerName }} chatId={job.chatId} viewer="hauler" setToast={setToast} />
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
            <Btn size="sm" variant="teal" full={false} onClick={() => onOpenChat(job.chatId)}>Open chat</Btn>
            {!job.completed && !job.haulerDoneAt && (
              <Btn size="sm" full={false} variant={completionOverdue ? "danger" : "primary"} disabled={!canMarkDone || marking} onClick={markDone}>
                {marking ? "Submitting…" : "✓ Mark work complete"}
              </Btn>
            )}
          </div>
          {!job.completed && !job.haulerDoneAt && !canMarkDone && (
            <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6 }}>
              Add at least one <strong>before</strong> and one <strong>after</strong> photo to mark the job complete.
            </div>
          )}
          {!job.completed && changeOrdersEnabled && (
            <ProposeBidRevisionControl job={job} onProposed={onRevisionProposed} setToast={setToast} />
          )}
          {!job.completed && (
            <RequestCancellationControl job={job} onRequested={onCancellationChanged} setToast={setToast} />
          )}
        </>
      )}
    </div>
  );
}
