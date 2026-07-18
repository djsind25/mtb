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
    setRequesting(true);
    try {
      await requestCancellation({ jobId: job.id, reason: reason.trim() || null });
      setToast("Cancellation requested — MyTrashBid will review it.");
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
        value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" rows={2}
        style={{
          width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
          padding: "8px 10px", fontSize: 12.5, fontFamily: "inherit", resize: "vertical", marginBottom: 6, color: C.ink,
        }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn size="sm" full={false} variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn>
        <Btn size="sm" full={false} variant="danger" disabled={requesting} onClick={submit}>{requesting ? "Requesting…" : "Submit request"}</Btn>
      </div>
    </div>
  );
}
