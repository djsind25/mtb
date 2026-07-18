import { useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { C, serif } from "../theme";
import { Btn, ErrorMsg } from "../ui/Primitives";
import { getStripe } from "../lib/stripeClient";

function PayForm({ onSuccess, onCancel, depositLabel }) {
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
        <Btn type="submit" disabled={!stripe || submitting}>{submitting ? "Processing…" : `Pay ${depositLabel} & lock in`}</Btn>
      </div>
    </form>
  );
}

export function AcceptBidPayment({ clientSecret, depositLabel, isFull, onSuccess, onCancel }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: 16, padding: 24, width: "100%", maxWidth: 420, border: `1px solid ${C.line}` }}>
        <div style={{ fontFamily: serif, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>{isFull ? "Pay in full to lock in" : "Pay deposit to lock in"}</div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>
          {isFull
            ? `Your ${depositLabel} is held securely by MyTrashBid and released to your hauler when the job is confirmed complete on both ends — hauler and customer.`
            : "Your money is held by MyTrashBid and this deposit is MyTrashBid's fee — the rest is settled directly with your hauler."}
        </div>
        <Elements stripe={getStripe()} options={{ clientSecret }}>
          <PayForm onSuccess={onSuccess} onCancel={onCancel} depositLabel={depositLabel} />
        </Elements>
      </div>
    </div>
  );
}
