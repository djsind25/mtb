import { useState } from "react";
import { C, sans, expiryLabel, isExpired, memberSinceLabel, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { acceptBid } from "./data";
import { AcceptBidPayment } from "./AcceptBidPayment";
import { entitlementsFor } from "../membership";

const SHOW_MEMBER_SINCE = true;

export function BidRow({ bid, jobId, paymentMode, onAccepted, setToast }) {
  const [starting, setStarting] = useState(false);
  const [payment, setPayment] = useState(null); // { clientSecret, chatId, deposit, balanceDue }
  const [showVerifyInfo, setShowVerifyInfo] = useState(false);
  const bidExpired = isExpired(bid.expires_at);
  const isFull = paymentMode === "full";
  // Display-only mirror of price_breakdown() — the server always recomputes this authoritatively
  // in accept_bid(), this is purely so the customer sees the right numbers before they commit.
  // Uses this specific hauler's tier entitlement rather than the flat global rate (wiring point
  // 2/2 for membership tiers — currently every tier resolves to the same 0.10, see membership.js).
  const commissionRate = entitlementsFor(bid.membershipTier).commissionRate;
  const depositNow = isFull ? bid.amount : +(bid.amount * commissionRate).toFixed(2);
  const balanceDue = isFull ? 0 : +(bid.amount - depositNow).toFixed(2);

  async function startAccept() {
    setStarting(true);
    try {
      const result = await acceptBid({ jobId, bidId: bid.id });
      if (result.requiresPayment === false) {
        // Full mode: nothing to pay yet — the job books immediately and opens into the
        // coordination window (see ScheduleProposal). No Stripe step at all.
        setToast("Job locked in! No money has moved yet — coordinate a service date and final price in chat.");
        onAccepted(result.chatId);
        setStarting(false);
        return;
      }
      setPayment(result);
    } catch (e) {
      setToast(e.message || "Could not start payment for this bid.");
    }
    setStarting(false);
  }

  function handlePaid() {
    setPayment(null);
    setToast(isFull
      ? `Job locked in! $${payment.deposit.toFixed(2)} is held securely by MyTrashBid and released to your hauler once the job is confirmed complete.`
      : `Job locked in for $${payment.deposit.toFixed(2)} deposit! Chat unlocked. $${payment.balanceDue.toFixed(2)} due to your hauler at completion.`);
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
            {bid.licenseActive && <span>🪪 Licensed</span>}
            {bid.insuranceActive && <span>🛡️ Insured</span>}
            {bid.verified && <span>✅ Verified</span>}
            {(bid.licenseActive || bid.insuranceActive || bid.verified) && (
              <button onClick={() => setShowVerifyInfo(true)} aria-label="How we verify haulers" style={{
                background: "none", border: `1px solid ${C.line}`, borderRadius: "50%", width: 15, height: 15,
                color: C.teal, cursor: "pointer", fontSize: 10, lineHeight: 1, padding: 0, fontFamily: "inherit",
              }}>ⓘ</button>
            )}
            {SHOW_MEMBER_SINCE && memberSinceLabel(bid.haulerSince) && <span>{memberSinceLabel(bid.haulerSince)}</span>}
          </div>
        </div>
        <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.teal }}>${bid.amount}</span>
      </div>
      {bid.note && <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 8 }}>"{bid.note}"</div>}
      <div style={{ marginBottom: 10 }}>
        <Badge color={bidExpired ? C.red : C.gray} bg={bidExpired ? C.redLight : C.grayLight}>{expiryLabel(bid.expires_at)}</Badge>
      </div>
      {bidExpired ? (
        <div style={{ fontSize: 12, color: C.red }}>This bid expired and can no longer be accepted. The hauler can renew it to reopen it.</div>
      ) : (
        <>
          {isFull ? (
            <div style={{ background: C.sand, borderRadius: RADIUS.sm, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: C.gray }}>Full price — nothing charged until 48h before your scheduled date</span>
                <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${depositNow.toFixed(2)}</span>
              </div>
            </div>
          ) : (
            <div style={{ background: C.sand, borderRadius: RADIUS.sm, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ color: C.gray }}>Pay now to lock in (10% deposit)</span>
                <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${depositNow.toFixed(2)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: C.gray }}>Pay hauler at completion</span>
                <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${balanceDue.toFixed(2)}</span>
              </div>
            </div>
          )}
          <Btn size="sm" disabled={starting} onClick={startAccept}>
            {starting ? "Locking in…" : isFull ? "Accept — no payment yet" : `Lock in job for $${depositNow.toFixed(2)} deposit`}
          </Btn>
          <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6, textAlign: "center" }}>
            {isFull
              ? "You'll coordinate a service date and final price in chat next — nothing is charged until 48 hours before that date."
              : `The $${balanceDue.toFixed(2)} balance is paid directly to your hauler — cash, check, or their preferred method. This bid is the agreed price; haulers may not demand extra on-site for the same scope.`}
          </div>
        </>
      )}

      {payment && (
        <AcceptBidPayment
          clientSecret={payment.clientSecret}
          depositLabel={`$${payment.deposit.toFixed(2)}`}
          isFull={isFull}
          onSuccess={handlePaid}
          onCancel={() => setPayment(null)}
        />
      )}

      {showVerifyInfo && (
        <div onClick={() => setShowVerifyInfo(false)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,20,0.55)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: C.paper, borderRadius: RADIUS.lg, padding: 20, maxWidth: 340, boxShadow: SHADOW_SM }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>How we verify haulers</div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: C.ink, lineHeight: 1.6 }}>
              <li style={{ marginBottom: 8 }}><strong>🪪 Licensed</strong> — their state/local business license is uploaded and checked by our admin team before it's marked active.</li>
              <li style={{ marginBottom: 8 }}><strong>🛡️ Insured</strong> — a current Certificate of Insurance (COI) is uploaded and its coverage dates are verified.</li>
              <li><strong>✅ Verified</strong> — once both are confirmed, the hauler is cleared to bid on jobs. Badges are rechecked as documents near expiration.</li>
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
