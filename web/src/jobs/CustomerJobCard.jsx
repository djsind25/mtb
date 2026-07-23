import { useRef, useState } from "react";
import { C, expiryLabel, isExpired, timelineMeta } from "../theme";
import { Badge, Btn, CenteredNote } from "../ui/Primitives";
import { BidRow } from "./BidRow";
import { JobPhotos } from "./JobPhotos";
import { JobQuestions } from "./JobQuestions";
import { JobUpdates } from "./JobUpdates";
import { addJobPhotos } from "./data";
import { CompletionPhotos } from "./CompletionPhotos";
import { TimelinePicker } from "./TimelinePicker";
import { SwitchHaulerPicker } from "./SwitchHaulerPicker";
import { RequestCancellationControl } from "./RequestCancellationControl";

export function CustomerJobCard({ job, completedCount, onAccepted, onSwitched, onCancellationChanged, onOpenChat, onRenewJob, onResendVerification, onUpdateTimeline, onAcknowledge, setToast }) {
  const [expanded, setExpanded] = useState(false);
  const [resending, setResending] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [photoRefreshKey, setPhotoRefreshKey] = useState(0);
  const photoInputRef = useRef(null);

  // JobPhotos only loads on mount — remounting it via a changed key is the simplest way to
  // pick up what was just uploaded, without needing a reload prop on that shared component.
  async function handleAddPhotos(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setAddingPhotos(true);
    try {
      await addJobPhotos({ jobId: job.id, files });
      setPhotoRefreshKey(k => k + 1);
    } catch (e) {
      setToast(e.message || "Could not add photos.");
    }
    setAddingPhotos(false);
  }
  const [acknowledging, setAcknowledging] = useState(false);
  const [editingTimeline, setEditingTimeline] = useState(false);
  const [pendingTimeline, setPendingTimeline] = useState(job.timeline);
  const [savingTimeline, setSavingTimeline] = useState(false);
  const [switching, setSwitching] = useState(false);
  const bids = job.bids || [];
  const canSwitchHauler = job.status === "booked" && !job.completed && !job.haulerDoneAt && !job.pendingCancellation
    && job.payment_mode === "full" && bids.some(b => b.id !== job.accepted_bid_id);
  const jobExpired = job.status === "open" && isExpired(job.expires_at);
  const timeline = timelineMeta(job.timeline);

  async function saveTimeline() {
    setSavingTimeline(true);
    try {
      await onUpdateTimeline(job.id, pendingTimeline);
      setEditingTimeline(false);
      setToast("Timeline updated.");
    } catch (e) {
      setToast(e.message || "Could not update timeline.");
    }
    setSavingTimeline(false);
  }

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
              <Badge
                color={job.status === "open" ? C.ember : job.status === "pending_verification" ? C.amber : job.status === "cancelled" ? C.gray : C.teal}
                bg={job.status === "open" ? C.emberLight : job.status === "pending_verification" ? C.amber + "22" : job.status === "cancelled" ? C.grayLight : C.tealLight}
              >
                {job.status === "open" ? `${bids.length} bid${bids.length !== 1 ? "s" : ""}`
                  : job.status === "pending_verification" ? "Verify email to activate"
                  : job.status === "cancelled" ? "Cancelled"
                  : "Booked"}
              </Badge>
              {timeline && <Badge color={timeline.color} bg={timeline.bg}>{timeline.urgent ? "⚡ " : ""}{timeline.label}</Badge>}
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
          <JobPhotos jobId={job.id} key={photoRefreshKey} />
          <div style={{ marginBottom: 14 }}>
            <input ref={photoInputRef} type="file" accept="image/*,.heic,.heif" multiple style={{ display: "none" }}
              onChange={e => { handleAddPhotos(e.target.files); e.target.value = ""; }} />
            <Btn size="sm" full={false} variant="ghost" disabled={addingPhotos} onClick={() => photoInputRef.current?.click()}>
              {addingPhotos ? "Adding…" : "📷 Add photos"}
            </Btn>
          </div>

          <JobUpdates jobId={job.id} viewerRole="customer" jobOpen={job.status === "open" && !jobExpired} setToast={setToast} />
          <JobQuestions jobId={job.id} viewerRole="customer" jobOpen={job.status === "open" && !jobExpired} setToast={setToast} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: editingTimeline ? 8 : 14 }}>
            <span style={{ fontSize: 12, color: C.gray, fontWeight: 600 }}>Timeline:</span>
            {timeline ? <Badge color={timeline.color} bg={timeline.bg}>{timeline.label}</Badge> : <span style={{ fontSize: 12, color: C.gray }}>Not set</span>}
            {job.status !== "booked" && !editingTimeline && (
              <button onClick={() => { setPendingTimeline(job.timeline); setEditingTimeline(true); }}
                style={{ background: "none", border: "none", color: C.teal, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                Change
              </button>
            )}
          </div>
          {editingTimeline && (
            <div style={{ marginBottom: 14 }}>
              <TimelinePicker value={pendingTimeline} onChange={setPendingTimeline} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <Btn size="sm" full={false} variant="ghost" onClick={() => setEditingTimeline(false)}>Cancel</Btn>
                <Btn size="sm" full={false} disabled={!pendingTimeline || savingTimeline} onClick={saveTimeline}>{savingTimeline ? "Saving…" : "Save"}</Btn>
              </div>
            </div>
          )}

          {job.status === "pending_verification" ? (
            <div>
              <div style={{ fontSize: 13, color: C.ink, fontWeight: 600, marginBottom: 10 }}>
                ⚠ Check your email and click the verification link to make this post visible to haulers.
                It'll go live automatically the moment you verify — no need to repost.
              </div>
              <Btn
                variant="ghost" full={false} disabled={resending}
                onClick={async () => {
                  setResending(true);
                  try {
                    await onResendVerification();
                    setToast("Verification email sent — check your inbox.");
                  } catch (e) {
                    setToast(e.message || "Could not resend verification email.");
                  }
                  setResending(false);
                }}
              >
                {resending ? "Sending…" : "Resend verification email"}
              </Btn>
            </div>
          ) : job.status === "booked" ? (
            <div>
              <div style={{ fontSize: 13, color: C.teal, fontWeight: 700, marginBottom: 6 }}>✓ Locked in</div>
              {job.completed ? (
                <div style={{ marginBottom: 10 }}>
                  <Badge color={C.teal} bg={C.tealLight}>✓ Completed — leave a review in chat</Badge>
                </div>
              ) : job.haulerDoneAt ? (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 13, color: C.ink, fontWeight: 600, marginBottom: 8 }}>
                    🧹 Your hauler marked this job complete. Review the before/after photos, then acknowledge.
                  </div>
                  <CompletionPhotos jobId={job.id} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Btn
                      variant="primary" full={false} disabled={acknowledging}
                      onClick={async () => {
                        setAcknowledging(true);
                        try {
                          await onAcknowledge(job.id);
                          setToast("Thanks! Job confirmed complete — you can leave a review in chat.");
                        } catch (e) {
                          setToast(e.message || "Could not acknowledge completion.");
                        }
                        setAcknowledging(false);
                      }}
                    >
                      {acknowledging ? "Confirming…" : "✓ Acknowledge job complete"}
                    </Btn>
                    <Btn variant="teal" full={false} onClick={() => onOpenChat(job.chatId)}>Open chat</Btn>
                  </div>
                  <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6 }}>
                    If you don't respond, this auto-confirms after 7 days.
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: 10 }}>
                    <Badge color={C.gray} bg={C.grayLight}>In progress — your hauler will mark it complete with photos</Badge>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Btn variant="teal" full={false} onClick={() => onOpenChat(job.chatId)}>Open chat</Btn>
                    {canSwitchHauler && (
                      <Btn variant="ghost" full={false} onClick={() => setSwitching(true)}>Switch hauler</Btn>
                    )}
                  </div>
                  {switching && (
                    <SwitchHaulerPicker job={job} onSwitched={onSwitched} setToast={setToast} onClose={() => setSwitching(false)} />
                  )}
                  <RequestCancellationControl job={job} onRequested={onCancellationChanged} setToast={setToast} />
                </>
              )}
              {job.haulerDoneAt && !job.completed && (
                <RequestCancellationControl job={job} onRequested={onCancellationChanged} setToast={setToast} />
              )}
            </div>
          ) : job.status === "cancelled" ? (
            <div>
              <Badge color={C.gray} bg={C.grayLight}>Cancelled by MyTrashBid</Badge>
              {job.chatId && (
                <div style={{ marginTop: 10 }}>
                  <Btn variant="ghost" full={false} onClick={() => onOpenChat(job.chatId)}>Open chat</Btn>
                </div>
              )}
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
                    {bids.map(bid => <BidRow key={bid.id} bid={bid} jobId={job.id} paymentMode={job.payment_mode} onAccepted={onAccepted} setToast={setToast} />)}
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
                {bids.map(bid => <BidRow key={bid.id} bid={bid} jobId={job.id} paymentMode={job.payment_mode} onAccepted={onAccepted} setToast={setToast} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
