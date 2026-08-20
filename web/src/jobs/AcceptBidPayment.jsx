import { useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { C, sans } from "../theme";
import { Btn, ErrorMsg } from "../ui/Primitives";
import { getStripe } from "../lib/stripeClient";

function PayForm({ onSuccess, onCancel, totalLabel }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError("");
    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    setSubmitting(false);
    if (confirmError) { setError(confirmError.message); return; }
    onSuccess(paymentIntent);
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && <div style={{ marginTop: 12 }}><ErrorMsg>{error}</ErrorMsg></div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" disabled={!stripe || submitting}>{submitting ? "Processing…" : `Pay ${totalLabel} & lock in`}</Btn>
      </div>
    </form>
  );
}

// The real breakdown (bidAmount/serviceFee/totalCharge) always comes from create-booking-charge's
// response — never estimated client-side — since the server is the only source of truth for the
// service_fee_rate that's actually in effect.
export function AcceptBidPayment({ clientSecret, bidAmount, serviceFee, totalCharge, onSuccess, onCancel }) {
  const totalLabel = `$${totalCharge.toFixed(2)}`;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: 16, padding: 24, width: "100%", maxWidth: 420, border: `1px solid ${C.line}` }}>
        <div style={{ fontFamily: sans, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>Pay to lock in</div>
        <div style={{ background: C.sand, borderRadius: 10, padding: "9px 11px", marginBottom: 12, fontSize: 12.5 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ color: C.gray }}>Bid amount</span>
            <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", color: C.ink }}>${bidAmount.toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ color: C.gray }}>Service fee</span>
            <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", color: C.ink }}>${serviceFee.toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, borderTop: `1px solid ${C.line}`, marginTop: 5, paddingTop: 5 }}>
            <span style={{ color: C.pineDeep }}>Total charged</span>
            <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", color: C.pineDeep }}>{totalLabel}</span>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>
          Held securely by MyTrashBid and released to your hauler once the job is confirmed complete on both ends — hauler and customer.
        </div>
        <Elements stripe={getStripe()} options={{ clientSecret }}>
          <PayForm onSuccess={onSuccess} onCancel={onCancel} totalLabel={totalLabel} />
        </Elements>
      </div>
    </div>
  );
}
