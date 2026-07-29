import { useState } from "react";
import { C } from "../theme";
import { Btn } from "../ui/Primitives";
import { requestCancellation } from "./data";

export function RequestCancellationControl({ job, onRequested, setToast }) {
  const [requesting, setRequesting] = useState(false);
  const [reason, setReason] = useState("");
  const [showForm, setShowForm] = useState(false);

  if (job.pendingCancellation) {
    return (
      <div style={{ fontSize: 11.5, color: "#8A6604", background: C.amberLight, borderRadius: 8, padding: "6px 10px", marginTop: 8 }}>
        ⏳ Cancellation requested — under review by MyTrashBid.
      </div>
    );
  }

  async function submit() {
    if (!reason.trim()) return;
    setRequesting(true);
    try {
      await requestCancellation({ jobId: job.id, reason: reason.trim() });
      // Message A from the scheduling spec — warm and low-friction, shown right at the moment of
      // cancelling. Deliberately not scolding: things come up. Message B (the separate "stay
      // protected" nudge) lives in the chat banner instead, not stacked here.
      setToast("Things come up — we get it. This cancellation will be reviewed by our team to keep things fair for both sides. Thanks for using MyTrashBid.");
      setShowForm(false);
      setReason("");
      onRequested();
    } catch (e) {
      setToast(e.message || "Could not request cancellation.");
    }
    setRequesting(false);
  }

  if (!showForm) {
    return <Btn size="sm" full={false} variant="ghost" onClick={() => setShowForm(true)}>Request cancellation</Btn>;
  }

  return (
    <div style={{ marginTop: 8 }}>
      <textarea
        value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for cancellation (required)" rows={2}
        style={{
          width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
          padding: "8px 10px", fontSize: 12.5, fontFamily: "inherit", resize: "vertical", marginBottom: 6, color: C.ink,
        }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn size="sm" full={false} variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn>
        <Btn size="sm" full={false} variant="danger" disabled={!reason.trim() || requesting} onClick={submit}>{requesting ? "Requesting…" : "Submit request"}</Btn>
      </div>
    </div>
  );
}
