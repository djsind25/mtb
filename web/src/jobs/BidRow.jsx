import { useState } from "react";
import { C, mono, expiryLabel, isExpired, COMMISSION_RATE } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { acceptBid } from "./data";
import { AcceptBidPayment } from "./AcceptBidPayment";

export function BidRow({ bid, jobId, onAccepted, setToast }) {
  const [starting, setStarting] = useState(false);
  const [payment, setPayment] = useState(null); // { clientSecret, chatId, deposit, balanceDue }
  const bidExpired = isExpired(bid.expires_at);
  const depositNow = +(bid.amount * COMMISSION_RATE).toFixed(2);
  const balanceDue = +(bid.amount - depositNow).toFixed(2);

  async function startAccept() {
    setStarting(true);
    try {
      const result = await acceptBid({ jobId, bidId: bid.id });
      setPayment(result);
    } catch (e) {
      setToast(e.message || "Could not start payment for this bid.");
    }
    setStarting(false);
  }

  function handlePaid() {
    setPayment(null);
    setToast(`Job locked in for $${payment.deposit.toFixed(2)} deposit! Chat unlocked. $${payment.balanceDue.toFixed(2)} due to your hauler at completion.`);
    onAccepted(payment.chatId);
  }

  return (
    <div style={{ border: `1px solid ${bidExpired ? C.amber + "66" : C.line}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: C.pineDeep }}>{bid.businessName}</span>
          {bid.ratingCount > 0 ? (
            <span style={{ fontSize: 11.5, color: "#E8A23D", marginLeft: 7 }}>★ {bid.rating.toFixed(1)} <span style={{ color: C.gray }}>({bid.ratingCount})</span></span>
          ) : (
            <span style={{ fontSize: 11.5, color: C.gray, marginLeft: 7 }}>No reviews yet</span>
          )}
        </div>
        <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${bid.amount}</span>
      </div>
      {bid.note && <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 8 }}>"{bid.note}"</div>}
      <div style={{ marginBottom: 10 }}>
        <Badge color={bidExpired ? C.red : C.gray} bg={bidExpired ? C.redLight : C.grayLight}>{expiryLabel(bid.expires_at)}</Badge>
      </div>
      {bidExpired ? (
        <div style={{ fontSize: 12, color: C.red }}>This bid expired and can no longer be accepted. The hauler can renew it to reopen it.</div>
      ) : (
        <>
          <div style={{ background: C.sand, borderRadius: 8, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ color: C.gray }}>Pay now to lock in (10% deposit)</span>
              <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${depositNow.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.gray }}>Pay hauler at completion</span>
              <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${balanceDue.toFixed(2)}</span>
            </div>
          </div>
          <Btn size="sm" disabled={starting} onClick={startAccept}>
            {starting ? "Starting payment…" : `Lock in job for $${depositNow.toFixed(2)} deposit`}
          </Btn>
          <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6, textAlign: "center" }}>
            The ${balanceDue.toFixed(2)} balance is paid directly to your hauler — cash, check, or their preferred method.
          </div>
        </>
      )}

      {payment && (
        <AcceptBidPayment
          clientSecret={payment.clientSecret}
          depositLabel={`$${payment.deposit.toFixed(2)}`}
          onSuccess={handlePaid}
          onCancel={() => setPayment(null)}
        />
      )}
    </div>
  );
}
