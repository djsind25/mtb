import { useState } from "react";
import { C, sans, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn, Field } from "../ui/Primitives";
import { proposeSchedule, confirmSchedule } from "../jobs/data";
import { JobProgressGauge, stageForJob } from "../jobs/JobProgressGauge";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATUS_LABEL = {
  legacyHeld: "Held by MyTrashBid",
  coordinating: "Coordinating",
  scheduled: "Scheduled",
  authorized: "Authorized & held",
  captured: "Captured",
};

const HISTORY_PILL = {
  pending: { label: "Pending confirmation", color: C.ember, bg: C.emberLight },
  superseded: { label: "Superseded", color: C.gray, bg: C.grayLight },
  confirmed: { label: "Confirmed", color: C.teal, bg: C.tealLight },
};

function Row({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: `1px solid ${C.line}`, fontSize: 12.5 }}>
      <span style={{ color: C.gray }}>{label}</span>
      <span style={{ fontWeight: 600, color: C.pineDeep, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// The persistent right-column companion to ChatThread's conversation — everything about the
// job's money/schedule state lives here now instead of being scattered across banners inline
// with the messages. Deliberately not a fork of ScheduleProposal.jsx: that component is shared
// with the job-card views (CustomerJobCard/HaulerBidStatusCard), which aren't part of this
// redesign, so this owns its own propose-form state and calls the same RPCs directly.
export function JobStatusPanel({ chat, pendingSchedule, scheduleHistory, viewer, viewerId, effectiveAmount, haulerCut, moneyState, isFull, deposit, balanceDue, onScheduleChanged, setToast }) {
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState("");
  const [price, setPrice] = useState(String(effectiveAmount));
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const otherRole = viewer === "customer" ? "hauler" : "customer";
  const isMineProposal = pendingSchedule && pendingSchedule.proposed_by === viewerId;

  async function submitPropose() {
    setSubmitting(true);
    try {
      await proposeSchedule({ jobId: chat.job_id, serviceDate: date, finalPrice: price });
      setToast("Proposed! This isn't locked in until the other side confirms.");
      setShowForm(false);
      onScheduleChanged();
    } catch (e) {
      setToast(e.message || "Could not propose a service date.");
    }
    setSubmitting(false);
  }

  async function doConfirm() {
    setConfirming(true);
    try {
      await confirmSchedule({ proposalId: pendingSchedule.id });
      setToast("Service date locked in!");
      onScheduleChanged();
    } catch (e) {
      setToast(e.message || "Could not confirm this service date.");
    }
    setConfirming(false);
  }

  const scheduledDate = pendingSchedule ? pendingSchedule.service_date : chat.locked_service_date;
  const latestPrice = pendingSchedule ? pendingSchedule.final_price : (chat.locked_final_price ?? chat.bid_amount);
  const paymentLabel = moneyState === "captured" ? "Captured"
    : moneyState === "authorized" ? "Authorized & held"
    : isFull ? "No charge yet"
    : "Deposit paid — balance due at completion";

  const cardStyle = { background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.lg, boxShadow: SHADOW_SM, padding: 16 };

  // A chat only ever exists once a bid is accepted, so this always starts at least at "booked" —
  // the pre-acceptance stages (posted/receiving bids) are only ever relevant on the job card.
  const progressStage = stageForJob({ status: "booked", completed: !!chat.customer_ack_at, haulerDoneAt: chat.hauler_done_at });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>Job Progress</div>
        <JobProgressGauge stage={progressStage} />
      </div>

      <div style={cardStyle}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Job details</div>
        <Row label="Status" value={STATUS_LABEL[moneyState]} />
        {isFull && <Row label="Scheduled date" value={formatDate(scheduledDate)} />}
        {isFull && <Row label={pendingSchedule ? "Latest price (pending)" : "Final price"} value={`$${Number(latestPrice).toFixed(0)}`} />}
        <div style={{ padding: "7px 0", fontSize: 12.5, display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: C.gray }}>Payment</span>
          <span style={{ fontWeight: 600, color: C.pineDeep }}>{paymentLabel}</span>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <span style={{ fontSize: 19, fontWeight: 700, color: C.pineDeep, fontVariantNumeric: "tabular-nums" }}>${effectiveAmount} total</span>
          {moneyState === "legacyHeld" && <Badge color={C.teal} bg={C.tealLight}>Held by MyTrashBid</Badge>}
          {moneyState === "coordinating" && <Badge color={C.gray} bg={C.grayLight}>No charge yet</Badge>}
          {moneyState === "scheduled" && <Badge color={C.gray} bg={C.grayLight}>Scheduled</Badge>}
          {moneyState === "authorized" && <Badge color={C.teal} bg={C.tealLight}>Authorized</Badge>}
          {moneyState === "captured" && <Badge color={C.teal} bg={C.tealLight}>Captured</Badge>}
          {!isFull && <Badge color={C.teal} bg={C.tealLight}>Deposit paid</Badge>}
        </div>

        {!isFull ? (
          <div style={{ fontSize: 12, color: C.gray, marginTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span>Deposit paid to MyTrashBid (10%)</span>
              <span style={{ fontWeight: 700, color: C.teal, fontVariantNumeric: "tabular-nums" }}>${deposit.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{viewer === "hauler" ? "You collect directly at completion" : "Pay hauler directly at completion"}</span>
              <span style={{ fontWeight: 700, color: C.pineDeep, fontVariantNumeric: "tabular-nums" }}>${balanceDue.toFixed(2)}</span>
            </div>
          </div>
        ) : moneyState !== "coordinating" ? (
          <div style={{ fontSize: 12, color: C.gray, marginTop: 8, display: "flex", justifyContent: "space-between" }}>
            <span>{viewer === "hauler" ? "You receive at completion (90%)" : "Released to hauler at completion (90%)"}</span>
            <span style={{ fontWeight: 700, color: C.pineDeep, fontVariantNumeric: "tabular-nums" }}>${haulerCut.toFixed(2)}</span>
          </div>
        ) : (
          <>
            {chat.stalled_at ? (
              <div style={{ marginTop: 8, background: C.redLight, border: `1px solid ${C.red}55`, borderRadius: RADIUS.sm, padding: "8px 10px", fontSize: 11.5, color: C.red, fontWeight: 600 }}>
                This job has stalled without a locked service date and is under MyTrashBid review.
              </div>
            ) : chat.coordination_extended_at ? (
              <div style={{ marginTop: 8, background: C.amberLight, border: `1px solid ${C.amber}55`, borderRadius: RADIUS.sm, padding: "8px 10px", fontSize: 11.5, color: "#8A6604", fontWeight: 600 }}>
                You haven't locked a service date yet — pick one to keep this job moving.
              </div>
            ) : null}

            {pendingSchedule && !isMineProposal && (
              <div style={{ marginTop: 8, fontSize: 12, color: C.gray }}>
                The {pendingSchedule.proposed_role} proposed {formatDate(pendingSchedule.service_date)} · ${pendingSchedule.final_price} — waiting for you to confirm.
              </div>
            )}
            {pendingSchedule && isMineProposal && (
              <div style={{ marginTop: 8, fontSize: 12, color: C.gray }}>
                You proposed {formatDate(pendingSchedule.service_date)} · ${pendingSchedule.final_price} — waiting for the {otherRole} to confirm.
              </div>
            )}

            {!showForm ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                {pendingSchedule && !isMineProposal && (
                  <Btn disabled={confirming} onClick={doConfirm}>{confirming ? "Confirming…" : "Confirm proposal"}</Btn>
                )}
                <Btn variant="ghost" onClick={() => setShowForm(true)}>
                  {pendingSchedule ? "Propose a different date/price" : "Propose a service date"}
                </Btn>
              </div>
            ) : (
              <div style={{ background: C.sand, borderRadius: RADIUS.sm, padding: "10px 12px", marginTop: 10 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Field label="Service date" value={date} onChange={setDate} type="date" required />
                  <Field label="Final price ($)" value={price} onChange={setPrice} type="number" required />
                </div>
                <div style={{ fontSize: 11, color: C.gray, marginBottom: 10 }}>
                  This isn't binding until the {otherRole} confirms — nothing is charged until 48 hours before the service date.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn>
                  <Btn disabled={!date || !price || submitting} onClick={submitPropose}>{submitting ? "Proposing…" : "Propose to " + otherRole}</Btn>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {scheduleHistory.length > 0 && (
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>Proposal history</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {scheduleHistory.map((row, i) => {
              const pill = HISTORY_PILL[row.status] || HISTORY_PILL.superseded;
              return (
                <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                  <span style={{
                    width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
                    background: row.status === "pending" ? C.ember : C.paper,
                    border: `2px solid ${row.status === "confirmed" ? C.teal : row.status === "pending" ? C.ember : C.grayLight}`,
                  }} />
                  <span style={{ color: C.pineDeep, fontWeight: 600, flexShrink: 0 }}>{formatDate(row.service_date)}</span>
                  <span style={{ color: C.gray, fontVariantNumeric: "tabular-nums" }}>${row.final_price}</span>
                  <Badge color={pill.color} bg={pill.bg}>{pill.label}</Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {isFull && !chat.customer_ack_at && (
        <div style={{ background: C.slateLight, borderRadius: RADIUS.md, padding: "10px 12px", fontSize: 11.5, color: C.slate, lineHeight: 1.5, fontWeight: 600 }}>
          Your job on MyTrashBid is protected. Off-platform deals have no coverage.
        </div>
      )}
    </div>
  );
}
