import { useState } from "react";
import { C, sans, nowStr, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn, Field, ErrorMsg, CenteredNote } from "../ui/Primitives";
import { processDisputeResolution } from "./data";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { UserLink } from "./UserLink";

const STATUS_BADGE = {
  open: { label: "Open", color: C.ember, bg: C.emberLight },
  reviewing: { label: "Reviewing", color: C.ember, bg: C.emberLight },
  resolved_customer: { label: "Resolved — customer", color: C.gray, bg: C.grayLight },
  resolved_provider: { label: "Resolved — hauler", color: C.gray, bg: C.grayLight },
};

function Row({ dispute, onChanged, setToast, readOnly, onViewUser }) {
  const refundable = Number(dispute.refundable ?? 0);
  const alreadyPaid = Number(dispute.alreadyPaid ?? 0);
  const haulerCut = Number(dispute.haulerCut ?? 0);
  // Held-but-not-yet-paid hauler share, if any — refundable + this always accounts for the full
  // amount collected (held + already released), same accounting identity job_refundable_charges/
  // job_reversible_payouts individually enforce.
  const unpaidHaulerShare = Math.max(0, haulerCut - alreadyPaid);

  const [refundInput, setRefundInput] = useState(String(refundable));
  const [providerInput, setProviderInput] = useState(String(alreadyPaid + unpaidHaulerShare));
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [showStepUp, setShowStepUp] = useState(false);

  const refundAmount = Number(refundInput) || 0;
  const providerAmount = Number(providerInput) || 0;
  const resolution = refundAmount >= providerAmount ? "resolved_customer" : "resolved_provider";
  const invalid = refundAmount < 0 || providerAmount < 0 || refundAmount > refundable + 0.005 || providerAmount > alreadyPaid + unpaidHaulerShare + 0.005;

  async function confirmResolve() {
    setProcessing(true);
    try {
      await processDisputeResolution({
        disputeId: dispute.id, jobId: dispute.job_id, resolution,
        refundAmount, providerPayoutAmount: providerAmount, note,
      });
      setToast(`Dispute resolved — $${refundAmount.toFixed(2)} refunded, $${providerAmount.toFixed(2)} to the hauler.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not resolve this dispute.");
    }
    setProcessing(false);
    setConfirming(false);
  }

  const badge = STATUS_BADGE[dispute.status] || STATUS_BADGE.open;
  const isOpen = dispute.status === "open" || dispute.status === "reviewing";

  return (
    <div style={{ background: C.paper, border: `1px solid ${isOpen ? C.ember + "66" : C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{dispute.jobTitle || "Job"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            <UserLink id={dispute.customerId} name={dispute.customerName} onViewUser={onViewUser} /> ↔{" "}
            <UserLink id={dispute.haulerId} name={dispute.haulerName} onViewUser={onViewUser} /> · ZIP {dispute.zip || "—"}
          </div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            Reported by <UserLink id={dispute.opened_by} name={dispute.openedByName || "the customer"} onViewUser={onViewUser} /> · {nowStr(dispute.created_at)}
          </div>
          {dispute.reason && (
            <div style={{ fontSize: 12, color: C.ink, marginTop: 4, fontStyle: "italic" }}>"{dispute.reason}"</div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${Number(dispute.bidAmount).toFixed(2)}</div>
          <div style={{ fontSize: 10.5, color: C.gray }}>bid total</div>
        </div>
      </div>

      {!isOpen ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Badge color={badge.color} bg={badge.bg}>{badge.label}</Badge>
          {dispute.refund_amount > 0 && <Badge color={C.red} bg={C.redLight}>Refunded ${Number(dispute.refund_amount).toFixed(2)}</Badge>}
          {dispute.provider_payout_amount > 0 && <Badge color={C.teal} bg={C.tealLight}>Hauler kept ${Number(dispute.provider_payout_amount).toFixed(2)}</Badge>}
        </div>
      ) : readOnly ? (
        <Badge color={C.ember} bg={C.emberLight}>{badge.label} — refundable ${refundable.toFixed(2)}, hauler share ${(alreadyPaid + unpaidHaulerShare).toFixed(2)}{alreadyPaid > 0 ? ` (${alreadyPaid.toFixed(2)} already paid)` : ""}</Badge>
      ) : (
        <div>
          <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 6 }}>
            Held: ${refundable.toFixed(2)} · Hauler share: ${(alreadyPaid + unpaidHaulerShare).toFixed(2)}{alreadyPaid > 0 ? ` ($${alreadyPaid.toFixed(2)} already paid — reducing this reverses part of it)` : " (not yet paid)"}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Refund to customer ($)" type="number" value={refundInput} onChange={setRefundInput} />
            <Field label="Hauler keeps ($)" type="number" value={providerInput} onChange={setProviderInput} />
          </div>
          {invalid && <ErrorMsg>Amounts can't exceed what's actually held/paid for this job.</ErrorMsg>}
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Resolution note (internal)</label>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
              style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "8px 10px", fontSize: 12.5, fontFamily: "inherit", outline: "none", resize: "vertical" }} />
          </div>
          {!confirming ? (
            <Btn variant="danger" full={false} disabled={invalid} onClick={() => setConfirming(true)}>Resolve</Btn>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" full={false} onClick={() => setConfirming(false)}>Cancel</Btn>
              <Btn variant="danger" full={false} disabled={processing} onClick={() => setShowStepUp(true)}>{processing ? "Processing…" : "Yes, resolve"}</Btn>
            </div>
          )}
        </div>
      )}
      {showStepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => { setShowStepUp(false); confirmResolve(); }}
          onCancel={() => setShowStepUp(false)}
        />
      )}
    </div>
  );
}

export function DisputesTab({ disputes, onChanged, setToast, readOnly, onViewUser }) {
  const open = disputes.filter(d => d.status === "open" || d.status === "reviewing");
  const resolved = disputes.filter(d => d.status !== "open" && d.status !== "reviewing");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {disputes.length === 0 && <CenteredNote>No disputes yet.</CenteredNote>}
      {open.map(d => <Row key={d.id} dispute={d} onChanged={onChanged} setToast={setToast} readOnly={readOnly} onViewUser={onViewUser} />)}
      {resolved.length > 0 && open.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 700, color: C.gray, marginTop: 6 }}>Resolved</div>
      )}
      {resolved.map(d => <Row key={d.id} dispute={d} onChanged={onChanged} setToast={setToast} readOnly={readOnly} onViewUser={onViewUser} />)}
    </div>
  );
}
