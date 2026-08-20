import { useState } from "react";
import { C, sans, expiryLabel, isExpired, memberSinceLabel, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { acceptBid } from "./data";
import { AcceptBidPayment } from "./AcceptBidPayment";
import { VERTICAL } from "../config/vertical";

const { howWeVerify } = VERTICAL.vetting;

const SHOW_MEMBER_SINCE = true;

export function BidRow({ bid, jobId, onAccepted, setToast }) {
  const [starting, setStarting] = useState(false);
  const [payment, setPayment] = useState(null); // { clientSecret, chatId, bidAmount, serviceFee, totalCharge }
  const [showVerifyInfo, setShowVerifyInfo] = useState(false);
  const bidExpired = isExpired(bid.expires_at);

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
    setToast(`Job locked in! $${payment.totalCharge.toFixed(2)} is held securely by MyTrashBid and released to your hauler once the job is confirmed complete.`);
    onAccepted(payment.chatId);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${bidExpired ? C.amber + "66" : C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <div>
            <span style={{ fontWeight: 700, fontSize: 13.5, color: C.pineDeep }}>{bid.businessName}</span>
            {bid.ratingCount > 0 ? (
              <span style={{ fontSize: 11.5, color: "#E8A23D", marginLeft: 7 }}>⭐ {bid.rating.toFixed(1)} <span style={{ color: C.gray }}>({bid.ratingCount})</span></span>
            ) : (
              <span style={{ fontSize: 11.5, color: C.gray, marginLeft: 7 }}>No reviews yet</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 3, fontSize: 11, color: C.gray, alignItems: "center" }}>
            {bid.licenseActive && <span>{howWeVerify.license.icon} {howWeVerify.license.title}</span>}
            {bid.insuranceActive && <span>{howWeVerify.insurance.icon} {howWeVerify.insurance.title}</span>}
            {bid.verified && <span>{howWeVerify.verified.icon} {howWeVerify.verified.title}</span>}
            {(bid.licenseActive || bid.insuranceActive || bid.verified) && (
              <button onClick={() => setShowVerifyInfo(true)} aria-label="How we verify haulers" style={{
                background: "none", border: `1px solid ${C.line}`, borderRadius: "50%", width: 15, height: 15,
                color: C.teal, cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0, fontFamily: "inherit",
              }}>ⓘ</button>
            )}
            {SHOW_MEMBER_SINCE && memberSinceLabel(bid.haulerSince) && <span>{memberSinceLabel(bid.haulerSince)}</span>}
          </div>
        </div>
        <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.teal }}>${Number(bid.amount).toFixed(2)}</span>
      </div>
      {bid.note && <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 8 }}>"{bid.note}"</div>}
      <div style={{ marginBottom: 10 }}>
        <Badge color={bidExpired ? C.red : C.gray} bg={bidExpired ? C.redLight : C.grayLight}>{expiryLabel(bid.expires_at)}</Badge>
      </div>
      {bidExpired ? (
        <div style={{ fontSize: 12, color: C.red }}>This bid expired and can no longer be accepted. The hauler can renew it to reopen it.</div>
      ) : (
        <>
          <div style={{ background: C.sand, borderRadius: RADIUS.sm, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.gray }}>Bid amount — charged in full to lock in</span>
              <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${Number(bid.amount).toFixed(2)}</span>
            </div>
          </div>
          <Btn size="sm" disabled={starting} onClick={startAccept}>
            {starting ? "Locking in…" : `Lock in job for $${Number(bid.amount).toFixed(2)}`}
          </Btn>
          <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6, textAlign: "center" }}>
            A service fee is added at checkout. Your payment is held securely by MyTrashBid and released to your hauler once the job is confirmed complete.
          </div>
        </>
      )}

      {payment && (
        <AcceptBidPayment
          clientSecret={payment.clientSecret}
          bidAmount={payment.bidAmount}
          serviceFee={payment.serviceFee}
          totalCharge={payment.totalCharge}
          onSuccess={handlePaid}
          onCancel={() => setPayment(null)}
        />
      )}

      {showVerifyInfo && (
        <div onClick={() => setShowVerifyInfo(false)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,20,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.paper, borderRadius: RADIUS.lg, padding: 20, maxWidth: 340, boxShadow: SHADOW_SM }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>How we verify haulers</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: C.ink, lineHeight: 1.6 }}>
              <li style={{ marginBottom: 8 }}><strong>{howWeVerify.license.icon} {howWeVerify.license.title}</strong> — {howWeVerify.license.desc}</li>
              <li style={{ marginBottom: 8 }}><strong>{howWeVerify.insurance.icon} {howWeVerify.insurance.title}</strong> — {howWeVerify.insurance.desc}</li>
              <li><strong>{howWeVerify.verified.icon} {howWeVerify.verified.title}</strong> — {howWeVerify.verified.desc}</li>
            </ul>
            <div style={{ marginTop: 14 }}>
              <Btn size="sm" full={false} variant="ghost" onClick={() => setShowVerifyInfo(false)}>Got it</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
