import { useState } from "react";
import { C, mono, nowStr } from "../theme";
import { Badge, Btn, Field, ErrorMsg } from "../ui/Primitives";
import { processCancellationRefund } from "./data";

function Row({ request, onChanged, setToast, readOnly }) {
  const [refundInput, setRefundInput] = useState(String(request.heldAmount ?? 0));
  const [confirming, setConfirming] = useState(false);
  const [processing, setProcessing] = useState(false);

  const heldAmount = Number(request.heldAmount ?? 0);
  const refundAmount = Number(refundInput) || 0;
  const retainedAmount = Math.max(0, heldAmount - refundAmount);
  const invalid = refundAmount < 0 || refundAmount > heldAmount + 0.005;

  async function confirmRefund() {
    setProcessing(true);
    try {
      await processCancellationRefund({ requestId: request.id, jobId: request.job_id, refundAmount });
      setToast(`Refunded $${refundAmount.toFixed(2)}${retainedAmount > 0 ? `, retained $${retainedAmount.toFixed(2)}` : ""}.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not process refund.");
    }
    setProcessing(false);
    setConfirming(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${request.status === "pending" ? C.ember + "66" : C.line}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{request.jobTitle || "Job"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            {request.customerName} ↔ {request.haulerName} · ZIP {request.zip || "—"}
          </div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            Requested by {request.requestedByName || "someone"} ({request.requested_role}) · {nowStr(request.created_at)}
          </div>
          {request.reason && (
            <div style={{ fontSize: 12, color: C.ink, marginTop: 4, fontStyle: "italic" }}>"{request.reason}"</div>
          )}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${Number(request.bidAmount).toFixed(2)}</div>
          <div style={{ fontSize: 10.5, color: C.gray }}>bid total</div>
        </div>
      </div>

      {request.status === "resolved" ? (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Badge color={C.gray} bg={C.grayLight}>Resolved</Badge>
          <Badge color={C.red} bg={C.redLight}>Refunded ${Number(request.refund_amount).toFixed(2)}</Badge>
          {Number(request.retained_amount) > 0 && <Badge color={C.teal} bg={C.tealLight}>Retained ${Number(request.retained_amount).toFixed(2)}</Badge>}
        </div>
      ) : readOnly ? (
        <Badge color={C.ember} bg={C.emberLight}>Pending — held: ${heldAmount.toFixed(2)}</Badge>
      ) : (
        <div>
          <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 6 }}>Held: ${heldAmount.toFixed(2)}</div>
          <Field label="Refund amount" type="number" value={refundInput} onChange={setRefundInput} />
          {retainedAmount > 0 && !invalid && (
            <div style={{ fontSize: 11.5, color: C.gray, marginTop: -8, marginBottom: 10 }}>${retainedAmount.toFixed(2)} will be retained.</div>
          )}
          {invalid && <ErrorMsg>Refund amount can't exceed the ${heldAmount.toFixed(2)} held.</ErrorMsg>}
          {!confirming ? (
            <Btn variant="danger" full={false} disabled={invalid} onClick={() => setConfirming(true)}>Refund ${refundAmount.toFixed(2)}</Btn>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" full={false} onClick={() => setConfirming(false)}>Cancel</Btn>
              <Btn variant="danger" full={false} disabled={processing} onClick={confirmRefund}>{processing ? "Processing…" : "Yes, refund"}</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function CancellationRequestsTab({ requests, onChanged, setToast, readOnly }) {
  const pending = requests.filter(r => r.status === "pending");
  const resolved = requests.filter(r => r.status === "resolved");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {requests.length === 0 && <div style={{ fontSize: 13, color: C.gray, textAlign: "center", padding: 24 }}>No cancellation requests yet.</div>}
      {pending.map(r => <Row key={r.id} request={r} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />)}
      {resolved.length > 0 && pending.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 700, color: C.gray, marginTop: 6 }}>Resolved</div>
      )}
      {resolved.map(r => <Row key={r.id} request={r} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />)}
    </div>
  );
}
