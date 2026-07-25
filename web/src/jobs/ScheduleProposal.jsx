import { useState } from "react";
import { C } from "../theme";
import { Badge, Btn, Field } from "../ui/Primitives";
import { proposeSchedule, confirmSchedule } from "./data";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Full-payment-mode only: the coordinate-a-date-then-hold-then-capture flow from the scheduling
// rework. Self-gates on payment_mode and on having scheduling data at all, so callers can render
// it unconditionally on every booked job without an extra check — a deposit-mode job or a full-mode
// job that predates this feature (accepted before the migration shipped, so coordination_deadline
// was never set) renders nothing here, exactly as it did before this feature existed.
export function ScheduleProposal({ job, viewerRole, viewerId, defaultPrice, onChanged, setToast }) {
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState("");
  const [price, setPrice] = useState(defaultPrice != null ? String(defaultPrice) : "");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (job.payment_mode !== "full") return null;
  if (!job.coordinationDeadline && !job.coordinationExtendedAt && !job.stalledAt && !job.lockedServiceDate) return null;

  const otherRole = viewerRole === "customer" ? "hauler" : "customer";

  async function submitPropose() {
    setSubmitting(true);
    try {
      await proposeSchedule({ jobId: job.id, serviceDate: date, finalPrice: price });
      setToast("Proposed! This isn't locked in until the other side confirms.");
      setShowForm(false);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not propose a service date.");
    }
    setSubmitting(false);
  }

  async function doConfirm() {
    setConfirming(true);
    try {
      await confirmSchedule({ proposalId: job.pendingSchedule.id });
      setToast("Service date locked in!");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not confirm this service date.");
    }
    setConfirming(false);
  }

  const proposeForm = (
    <div style={{ background: C.sand, borderRadius: 8, padding: "10px 12px", marginTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="Service date" value={date} onChange={setDate} type="date" required />
        <Field label="Final price ($)" value={price} onChange={setPrice} type="number" required />
      </div>
      <div style={{ fontSize: 11, color: C.gray, marginBottom: 10 }}>
        This isn't binding until the {otherRole} confirms — nothing is charged until 48 hours before the service date.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn size="sm" full={false} variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn>
        <Btn size="sm" full={false} disabled={!date || !price || submitting} onClick={submitPropose}>
          {submitting ? "Proposing…" : "Propose to " + otherRole}
        </Btn>
      </div>
    </div>
  );

  // Already captured — job's done, nothing left to coordinate.
  if (job.capturedAt) {
    return (
      <div style={{ marginTop: 8 }}>
        <Badge color={C.teal} bg={C.tealLight}>✓ ${job.lockedFinalPrice} captured — released per the 90/10 split</Badge>
      </div>
    );
  }

  // Authorized (held) but not yet captured.
  if (job.authorizedAt) {
    return (
      <div style={{ marginTop: 8 }}>
        <Badge color={C.teal} bg={C.tealLight}>💳 ${job.lockedFinalPrice} authorized and held for {formatDate(job.lockedServiceDate)}</Badge>
      </div>
    );
  }

  // Locked, waiting for the authorization window.
  if (job.lockedServiceDate) {
    return (
      <div style={{ marginTop: 8, background: C.tealLight, borderRadius: 8, padding: "9px 12px", fontSize: 12, color: C.pineDeep }}>
        <div style={{ fontWeight: 700, marginBottom: 3 }}>📅 Service date: {formatDate(job.lockedServiceDate)} · Final price: ${job.lockedFinalPrice}</div>
        <div style={{ color: C.gray }}>
          {viewerRole === "customer"
            ? `Your card will be authorized for $${job.lockedFinalPrice} 48 hours before your ${formatDate(job.lockedServiceDate)} service. You're only charged once the job is confirmed complete.`
            : `The customer's card will be authorized 48 hours before the ${formatDate(job.lockedServiceDate)} service date, and captured once you both confirm the job complete.`}
        </div>
      </div>
    );
  }

  const stallBanner = job.stalledAt ? (
    <div style={{ marginTop: 8, background: C.redLight, border: `1px solid ${C.red}55`, borderRadius: 8, padding: "9px 12px", fontSize: 12, color: C.red, fontWeight: 600 }}>
      🚩 This job has stalled without a locked service date and is under MyTrashBid review.
    </div>
  ) : job.coordinationExtendedAt ? (
    <div style={{ marginTop: 8, background: C.amberLight, border: `1px solid ${C.amber}55`, borderRadius: 8, padding: "9px 12px", fontSize: 12, color: "#8A6604", fontWeight: 600 }}>
      ⏰ You haven't locked a service date yet — pick one to keep this job moving.
    </div>
  ) : null;

  const pending = job.pendingSchedule;
  if (pending) {
    const isMine = pending.proposed_by === viewerId;
    return (
      <div>
        {stallBanner}
        <div style={{ marginTop: 8, background: C.sand, borderRadius: 8, padding: "9px 12px", fontSize: 12 }}>
          {isMine ? (
            <div style={{ color: C.gray }}>⏳ You proposed {formatDate(pending.service_date)} · ${pending.final_price} — waiting for the {otherRole} to confirm.</div>
          ) : (
            <>
              <div style={{ fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>
                📅 The {pending.proposed_role} proposed {formatDate(pending.service_date)} · ${pending.final_price}
              </div>
              <Btn size="sm" full={false} disabled={confirming} onClick={doConfirm}>{confirming ? "Confirming…" : "Confirm"}</Btn>
            </>
          )}
          {!showForm ? (
            <button onClick={() => setShowForm(true)} style={{ display: "block", background: "none", border: "none", color: C.teal, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 8 }}>
              Propose a different date/price
            </button>
          ) : proposeForm}
        </div>
      </div>
    );
  }

  return (
    <div>
      {stallBanner}
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{ display: "block", background: "none", border: "none", color: C.teal, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 8 }}>
          📅 Propose a service date
        </button>
      ) : proposeForm}
    </div>
  );
}
