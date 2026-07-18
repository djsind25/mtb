import { useState } from "react";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { C, mono, serif } from "../theme";
import { Btn, ErrorMsg } from "../ui/Primitives";
import { getStripe } from "../lib/stripeClient";
import { previewBidSwitch, startBidSwitch, confirmBidSwitch } from "./data";

function DeltaPayForm({ jobId, newBidId, delta, onDone, onCancel, setToast }) {
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
    if (confirmError) {
      setSubmitting(false);
      setError(confirmError.message);
      return;
    }
    try {
      const result = await confirmBidSwitch({ jobId, newBidId, paymentIntentId: paymentIntent.id });
      onDone(result);
    } catch (e2) {
      setToast(e2.message || "Payment succeeded but the switch could not be completed. Contact support.");
    }
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && <div style={{ marginTop: 12 }}><ErrorMsg>{error}</ErrorMsg></div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancel</Btn>
        <Btn type="submit" disabled={!stripe || submitting}>{submitting ? "Processing…" : `Pay $${delta.toFixed(2)} & switch`}</Btn>
      </div>
    </form>
  );
}

export function SwitchHaulerPicker({ job, onSwitched, setToast, onClose }) {
  const otherBids = (job.bids || []).filter(b => b.id !== job.accepted_bid_id);
  const [selected, setSelected] = useState(null); // bid
  const [preview, setPreview] = useState(null); // { delta, current_bid_amount, new_bid_amount }
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clientSecret, setClientSecret] = useState(null);

  async function selectBid(bid) {
    setSelected(bid);
    setPreview(null);
    setPreviewing(true);
    try {
      const p = await previewBidSwitch({ jobId: job.id, newBidId: bid.id });
      setPreview(p);
    } catch (e) {
      setToast(e.message || "Could not preview this switch.");
      setSelected(null);
    }
    setPreviewing(false);
  }

  async function confirmSwitch() {
    setConfirming(true);
    try {
      const result = await startBidSwitch({ jobId: job.id, newBidId: selected.id });
      if (result.finalized) {
        setToast(`Switched to ${selected.businessName}.`);
        onSwitched(result.chat_id);
        onClose();
      } else {
        setClientSecret(result.clientSecret);
      }
    } catch (e) {
      setToast(e.message || "Could not switch haulers.");
    }
    setConfirming(false);
  }

  function handleDeltaPaid(result) {
    setClientSecret(null);
    setToast(`Switched to ${selected.businessName}.`);
    onSwitched(result.chat_id);
    onClose();
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: 16, padding: 24, width: "100%", maxWidth: 420, border: `1px solid ${C.line}`, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ fontFamily: serif, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>Switch hauler</div>

        {!selected ? (
          <>
            <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 14 }}>
              Your held funds stay put — only the price difference, if any, is charged or refunded.
            </div>
            {otherBids.length === 0 ? (
              <div style={{ fontSize: 13, color: C.gray, marginBottom: 14 }}>No other bids to switch to.</div>
            ) : (
              <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
                {otherBids.map(bid => (
                  <button key={bid.id} onClick={() => selectBid(bid)} style={{
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                    border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px",
                    background: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                  }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>{bid.businessName}</span>
                    <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${bid.amount}</span>
                  </button>
                ))}
              </div>
            )}
            <Btn variant="ghost" onClick={onClose}>Close</Btn>
          </>
        ) : previewing ? (
          <div style={{ fontSize: 13, color: C.gray, padding: "20px 0" }}>Checking price difference…</div>
        ) : clientSecret ? (
          <>
            <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>
              Switching to {selected.businessName} costs ${preview.delta.toFixed(2)} more — this amount joins the rest already held and is released to your hauler the same way, once the job is confirmed complete.
            </div>
            <Elements stripe={getStripe()} options={{ clientSecret }}>
              <DeltaPayForm jobId={job.id} newBidId={selected.id} delta={preview.delta}
                onDone={handleDeltaPaid} onCancel={() => { setClientSecret(null); setSelected(null); }} setToast={setToast} />
            </Elements>
          </>
        ) : preview ? (
          <>
            <div style={{ fontSize: 13, color: C.ink, marginBottom: 6 }}>
              Switch to <strong>{selected.businessName}</strong> — ${preview.new_bid_amount}
            </div>
            <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>
              {preview.delta > 0
                ? `This bid is $${preview.delta.toFixed(2)} more than what's currently held. You'll be asked to pay just that difference.`
                : preview.delta < 0
                ? `This bid is $${Math.abs(preview.delta).toFixed(2)} less than what's currently held. That difference will be refunded automatically.`
                : "Same price — nothing more to pay or refund."}
              {" "}The old hauler will be notified and loses access to this job.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="ghost" onClick={() => setSelected(null)}>Back</Btn>
              <Btn disabled={confirming} onClick={confirmSwitch}>{confirming ? "Switching…" : "Confirm switch"}</Btn>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
