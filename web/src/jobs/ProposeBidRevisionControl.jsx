import { useState } from "react";
import { C } from "../theme";
import { Btn } from "../ui/Primitives";
import { proposeBidRevision } from "./data";

// Append-only "change order" proposal — this never edits the original bid or the job's locked-in
// chat.bid_amount, it inserts a new bid_revisions row (see propose_bid_revision) and posts a
// system message in chat with the old → new price. Not binding until the customer approves it in
// their own job card (CustomerJobCard's matching banner).
export function ProposeBidRevisionControl({ job, onProposed, setToast }) {
  const [proposing, setProposing] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [showForm, setShowForm] = useState(false);

  if (job.pendingRevision) {
    return (
      <div style={{ fontSize: 11.5, color: "#8A6604", background: C.amberLight, borderRadius: 8, padding: "6px 10px", marginTop: 8 }}>
        ⏳ Price revision proposed — ${job.pendingRevision.old_amount} → ${job.pendingRevision.new_amount}, awaiting customer response.
      </div>
    );
  }

  async function submit() {
    if (!amount.trim() || !reason.trim()) return;
    setProposing(true);
    try {
      await proposeBidRevision({ jobId: job.id, newAmount: amount, reason: reason.trim() });
      setToast("Price revision proposed — the customer needs to approve it before it takes effect.");
      setShowForm(false);
      setAmount("");
      setReason("");
      onProposed();
    } catch (e) {
      setToast(e.message || "Could not propose a price revision.");
    }
    setProposing(false);
  }

  if (!showForm) {
    return <Btn size="sm" full={false} variant="ghost" onClick={() => setShowForm(true)}>Propose new price</Btn>;
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="New total price ($)"
        style={{
          width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
          padding: "8px 10px", fontSize: 12.5, fontFamily: "inherit", color: C.ink, marginBottom: 6,
        }} />
      <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required)" rows={2}
        style={{
          width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
          padding: "8px 10px", fontSize: 12.5, fontFamily: "inherit", resize: "vertical", marginBottom: 6, color: C.ink,
        }} />
      <div style={{ fontSize: 10.5, color: C.gray, marginBottom: 6 }}>
        This doesn't take effect until the customer approves it — the current price stands until then.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn size="sm" full={false} variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn>
        <Btn size="sm" full={false} disabled={!amount.trim() || !reason.trim() || proposing} onClick={submit}>
          {proposing ? "Proposing…" : "Propose to customer"}
        </Btn>
      </div>
    </div>
  );
}
