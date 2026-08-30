import { useEffect, useState } from "react";
import { C, sans, expiryLabel, isExpired, fullDateLabel, timelineMeta, RADIUS, SHADOW_SM, SHADOW_MD } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { AdminChatViewer } from "./AdminChatViewer";
import { JobQuestions } from "../jobs/JobQuestions";
import { JobUpdates } from "../jobs/JobUpdates";
import { JobPhotos } from "../jobs/JobPhotos";
import { CompletionPhotos } from "../jobs/CompletionPhotos";
import { getOrCreateMySupportChat } from "../support/data";
import { SupportChatThread } from "../support/SupportChatThread";
import { VERTICAL } from "../config/vertical";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { adminRemoveJob, adminFlagJobNeedsInfo, loadJobModerationHistory, loadJobSupportChats } from "./data";

const MODERATION_LABEL = {
  removed: { label: "Removed", color: C.red, bg: C.redLight },
  flagged_needs_info: { label: "Flagged — needs info", color: C.amber, bg: C.amberLight },
};

// The admin moderation actions block: a badge for the job's current moderation_status, "Remove
// job" / "Flag — needs more info" buttons (each gated by a required reason + StepUpChallenge,
// same shape as AccountDeletionsTab's suspend/anonymize actions), and the append-only history
// from job_moderation_audit_log. Kept as its own component so JobRowExpanded's already-large body
// doesn't grow further, and so the history fetch only fires once a job has actually been
// moderated at least once.
function JobModerationPanel({ job, onChanged, setToast, readOnly }) {
  const [reason, setReason] = useState("");
  const [stepUp, setStepUp] = useState(null); // null | "remove" | "flag"
  const [working, setWorking] = useState(false);
  const [history, setHistory] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const moderation = MODERATION_LABEL[job.moderation_status];

  useEffect(() => {
    if (!showHistory || history !== null) return;
    let cancelled = false;
    loadJobModerationHistory(job.id).then(h => { if (!cancelled) setHistory(h); }).catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHistory]);

  async function doRemove() {
    setWorking(true);
    try {
      await adminRemoveJob(job.id, reason.trim());
      setToast("Job removed — bidding haulers were notified.");
      setReason("");
      setHistory(null);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not remove this job.");
    }
    setWorking(false);
  }

  async function doFlag() {
    setWorking(true);
    try {
      await adminFlagJobNeedsInfo(job.id, reason.trim());
      setToast("Job flagged — the customer can add info and resubmit.");
      setReason("");
      setHistory(null);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not flag this job.");
    }
    setWorking(false);
  }

  return (
    <div style={{ background: C.sand, borderRadius: RADIUS.sm, padding: "10px 12px", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: moderation ? 6 : 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep }}>Moderation</span>
        {moderation && <Badge color={moderation.color} bg={moderation.bg}>{moderation.label}</Badge>}
      </div>

      {job.moderation_reason && (
        <div style={{ fontSize: 12, color: C.ink, marginBottom: 8, fontStyle: "italic" }}>"{job.moderation_reason}"</div>
      )}

      {!readOnly && !moderation && (
        <>
          {job.status === "booked" ? (
            <div style={{ fontSize: 11.5, color: C.gray }}>
              This job is booked — use the Cancellation Requests review flow to moderate it, not Remove.
            </div>
          ) : (
            <>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required)"
                style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, fontFamily: "inherit", marginBottom: 6 }} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn size="sm" full={false} variant="danger" disabled={working || !reason.trim()} onClick={() => setStepUp("remove")}>
                  Remove job
                </Btn>
                {job.status === "open" && (
                  <Btn size="sm" full={false} variant="ghost" disabled={working || !reason.trim()} onClick={() => setStepUp("flag")}>
                    Flag — needs more info
                  </Btn>
                )}
              </div>
            </>
          )}
        </>
      )}

      <button onClick={() => setShowHistory(s => !s)} style={{ background: "none", border: "none", padding: 0, marginTop: 8, color: C.teal, fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: sans }}>
        {showHistory ? "Hide" : "Show"} moderation history
      </button>
      {showHistory && (
        <div style={{ marginTop: 6 }}>
          {history === null && <div style={{ fontSize: 11.5, color: C.gray }}>Loading…</div>}
          {history?.length === 0 && <div style={{ fontSize: 11.5, color: C.gray }}>No moderation events on this job.</div>}
          {history?.map(h => (
            <div key={h.id} style={{ fontSize: 11.5, color: C.gray, padding: "4px 0", borderTop: `1px solid ${C.line}` }}>
              <strong style={{ color: C.pineDeep }}>{h.action}</strong> · {new Date(h.created_at).toLocaleString()}
              {h.reason && ` — "${h.reason}"`}
              {h.bidder_count > 0 && ` · ${h.bidder_count} hauler${h.bidder_count === 1 ? "" : "s"} notified`}
            </div>
          ))}
        </div>
      )}

      {stepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => {
            const action = stepUp;
            setStepUp(null);
            if (action === "remove") doRemove();
            else if (action === "flag") doFlag();
          }}
          onCancel={() => setStepUp(null)}
        />
      )}
    </div>
  );
}

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

export function JobRow({ job, onClick }) {
  const timeline = timelineMeta(job.timeline, job.timeline_date);
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0",
        border: "none", borderBottom: `1px solid ${C.line}`, fontSize: 13, width: "100%",
        background: "none", textAlign: "left", fontFamily: "inherit", cursor: onClick ? "pointer" : "default",
      }}
    >
      <span style={{ color: C.ink, fontWeight: 600 }}>{job.title}</span>
      <div style={{ display: "flex", gap: 6 }}>
        {MODERATION_LABEL[job.moderation_status] && (
          <Badge color={MODERATION_LABEL[job.moderation_status].color} bg={MODERATION_LABEL[job.moderation_status].bg}>
            {MODERATION_LABEL[job.moderation_status].label}
          </Badge>
        )}
        {timeline && <Badge color={timeline.color} bg={timeline.bg}>{timeline.label}</Badge>}
        <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
      </div>
    </Tag>
  );
}

export function JobRowExpanded({ job, onViewCustomer, session, setToast, readOnly, onChanged }) {
  const [open, setOpen] = useState(false);
  const [viewingChat, setViewingChat] = useState(false);
  const [messagingChatId, setMessagingChatId] = useState(null);
  const [messagingLabel, setMessagingLabel] = useState("");
  const [startingMessage, setStartingMessage] = useState(null); // null | "customer" | "hauler"
  const [jobSupportChats, setJobSupportChats] = useState(null); // null = not loaded yet
  const [messagingIsJobThread, setMessagingIsJobThread] = useState(false);
  const jobExpired = job.status === "open" && isExpired(job.expires_at);
  const timeline = timelineMeta(job.timeline, job.timeline_date);
  const acceptedBid = (job.bids || []).find(b => b.id === job.accepted_bid_id);
  // first_posted_at is stamped once at creation and never touched by renew_job() — created_at
  // keeps meaning "last (re)posted", so it only differs from first_posted_at once renewed.
  const wasRenewed = job.first_posted_at && job.created_at && job.first_posted_at !== job.created_at;

  // Lazy-loaded on first expand rather than up front for every row in the jobs list.
  useEffect(() => {
    if (!open || jobSupportChats !== null) return;
    let cancelled = false;
    loadJobSupportChats(job.id).then(chats => { if (!cancelled) setJobSupportChats(chats); });
    return () => { cancelled = true; };
  }, [open, job.id, jobSupportChats]);

  function viewJobSupportChat(chat) {
    const role = chat.participant_role === "hauler" ? VERTICAL.roles.hauler.label : VERTICAL.roles.customer.label;
    setMessagingChatId(chat.id);
    setMessagingLabel(`Job support thread — ${role} ${chat.requesterName || "Unknown"}`);
    setMessagingIsJobThread(true);
  }

  async function startMessage(userId, label, which) {
    setStartingMessage(which);
    try {
      const chat = await getOrCreateMySupportChat(userId);
      setMessagingChatId(chat.id);
      setMessagingLabel(label);
      setMessagingIsJobThread(false);
    } catch (e) {
      setToast?.(e.message || "Could not start a conversation.");
    }
    setStartingMessage(null);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, overflow: "hidden" }}>
      <div
        role="button" tabIndex={0} onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(o => !o); } }}
        style={{ width: "100%", boxSizing: "border-box", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
      >
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{job.title}</div>
          <div style={{ fontSize: 11, color: C.gray }}>
            by {onViewCustomer ? (
              <button
                onClick={e => { e.stopPropagation(); onViewCustomer(job); }}
                style={{ background: "none", border: "none", padding: 0, font: "inherit", color: C.teal, textDecoration: "underline", cursor: "pointer" }}
              >
                {job.customerName || "—"}
              </button>
            ) : (job.customerName || "—")} · ZIP {job.zip} · {(job.bids || []).length} bids
          </div>
          {job.first_posted_at && (
            <div style={{ fontSize: 10.5, color: C.gray, marginTop: 2 }}>
              Posted {fullDateLabel(job.first_posted_at)}{wasRenewed ? ` · Renewed ${fullDateLabel(job.created_at)}` : ""}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {MODERATION_LABEL[job.moderation_status] && (
            <Badge color={MODERATION_LABEL[job.moderation_status].color} bg={MODERATION_LABEL[job.moderation_status].bg}>
              {MODERATION_LABEL[job.moderation_status].label}
            </Badge>
          )}
          {timeline && <Badge color={timeline.color} bg={timeline.bg}>{timeline.label}</Badge>}
          {job.status === "open" && <Badge color={jobExpired ? C.red : C.gray} bg={jobExpired ? C.redLight : C.grayLight}>{expiryLabel(job.expires_at, { renewable: true })}</Badge>}
          <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 14px" }}>
          <p style={{ fontSize: 13, color: C.gray, marginTop: 0, marginBottom: 12, lineHeight: 1.5 }}>
            {job.description || "No description provided."}
          </p>
          <JobModerationPanel job={job} onChanged={onChanged || (() => {})} setToast={setToast} readOnly={readOnly} />
          {session && !readOnly && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <Btn size="sm" full={false} variant="ghost" disabled={startingMessage === "customer"}
                onClick={() => startMessage(job.customer_id, job.customerName || VERTICAL.roles.customer.label, "customer")}>
                {startingMessage === "customer" ? "Opening…" : "💬 Message customer"}
              </Btn>
              {acceptedBid && (
                <Btn size="sm" full={false} variant="ghost" disabled={startingMessage === "hauler"}
                  onClick={() => startMessage(acceptedBid.hauler_id, acceptedBid.businessName || VERTICAL.roles.hauler.label, "hauler")}>
                  {startingMessage === "hauler" ? "Opening…" : "💬 Message hauler"}
                </Btn>
              )}
            </div>
          )}
          {/* Threads the customer or hauler opened themselves via "Contact support about this job" —
              a separate, always-available line from the shared chat above ("Message customer/hauler"
              is admin proactively reaching out; this is the reverse). Admin reads/replies but never
              creates one of these, so there's nothing to show until one exists. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Support threads for this job</div>
            {jobSupportChats === null ? (
              <div style={{ fontSize: 11.5, color: C.gray }}>Loading…</div>
            ) : jobSupportChats.length === 0 ? (
              <div style={{ fontSize: 11.5, color: C.gray }}>No customer or hauler has opened a support thread for this job yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {jobSupportChats.map(c => (
                  <button key={c.id} onClick={() => viewJobSupportChat(c)} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%",
                    background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "7px 10px",
                    fontSize: 12, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  }}>
                    <span>
                      <strong style={{ color: C.pineDeep }}>{c.participant_role === "hauler" ? VERTICAL.roles.hauler.label : VERTICAL.roles.customer.label}</strong>
                      {" "}— {c.requesterName || "Unknown"}
                    </span>
                    {c.status === "closed" ? <Badge color={C.gray} bg={C.grayLight}>closed</Badge> : <Badge color={C.teal} bg={C.tealLight}>open</Badge>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Once booked, CompletionPhotos below already merges these same customer photos into
              its own gallery (labeled "Customer photo") alongside before/after — showing this
              standalone strip too would just duplicate them. */}
          {job.status !== "booked" && <JobPhotos jobId={job.id} />}
          {job.status === "booked" && <CompletionPhotos jobId={job.id} />}
          <JobUpdates jobId={job.id} viewerRole="admin" jobOpen={job.status === "open" && !jobExpired} />
          <JobQuestions jobId={job.id} viewerRole="admin" jobOpen={job.status === "open" && !jobExpired} />
          {job.status === "booked" && job.chatId && (
            <div style={{ marginBottom: 10 }}>
              <Btn size="sm" full={false} variant="teal" onClick={() => setViewingChat(true)}>{readOnly ? "💬 View conversation" : "💬 Join job conversation"}</Btn>
            </div>
          )}
          {job.status === "booked" && job.scheduling && schedulingState(job.scheduling) && (
            <div style={{ background: C.sand, borderRadius: RADIUS.sm, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: job.scheduling.lockedServiceDate ? 4 : 0 }}>
                <span style={{ fontWeight: 700, color: C.pineDeep }}>Scheduling:</span>
                <Badge color={schedulingState(job.scheduling).color} bg={schedulingState(job.scheduling).bg}>{schedulingState(job.scheduling).label}</Badge>
              </div>
              {job.scheduling.lockedServiceDate && (
                <div style={{ color: C.gray }}>
                  {formatDate(job.scheduling.lockedServiceDate)} · ${Number(job.scheduling.lockedFinalPrice).toFixed(2)}
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
              <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>${Number(b.amount).toFixed(2)} <span style={{ color: C.gray, fontWeight: 400 }}>(${(b.amount * 0.1).toFixed(2)} deposit)</span></span>
            </div>
          ))}
        </div>
      )}
      {viewingChat && (
        <AdminChatViewer
          chatId={job.chatId}
          viewerId={session?.id}
          readOnly={readOnly}
          setToast={setToast}
          onClose={() => setViewingChat(false)}
        />
      )}
      {messagingChatId && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div style={{ background: C.paper, borderRadius: RADIUS.lg, boxShadow: SHADOW_MD, width: "100%", maxWidth: 480, border: `1px solid ${C.line}`, padding: "16px 16px 0" }}>
            <SupportChatThread
              supportChatId={messagingChatId}
              viewerRole="admin"
              viewerId={session?.id}
              title={messagingIsJobThread ? messagingLabel : `Message to ${messagingLabel}`}
              onClose={() => { setMessagingChatId(null); if (messagingIsJobThread) setJobSupportChats(null); }}
              setToast={setToast}
            />
          </div>
        </div>
      )}
    </div>
  );
}
