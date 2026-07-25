import { useState } from "react";
import { C } from "../theme";
import { Btn } from "../ui/Primitives";
import { resolveBidRevision } from "./data";

// Shown whenever a pending revision exists, regardless of the current change_orders_enabled
// flag — a proposal made while it was on still needs a resolution even if it's since been turned
// off. Declining leaves the standing price exactly as it was; nothing to undo.
export function ResolveBidRevisionControl({ job, onResolved, setToast }) {
  const [confirming, setConfirming] = useState(null); // "approve" | "decline" | null
  const [working, setWorking] = useState(false);
  const revision = job.pendingRevision;
  if (!revision) return null;

  async function resolve(approved) {
    setWorking(true);
    try {
      await resolveBidRevision({ revisionId: revision.id, approved });
      setToast(approved ? "Price change approved." : "Price change declined — the original price stands.");
      onResolved();
    } catch (e) {
      setToast(e.message || "Could not respond to this price revision.");
    }
    setWorking(false);
    setConfirming(null);
  }

  return (
    <div style={{ border: `1px solid ${C.amber}66`, background: C.amberLight, borderRadius: 10, padding: "10px 12px", marginTop: 8 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8A6604", marginBottom: 4 }}>
        💰 Your hauler proposed a new price: ${revision.old_amount} → ${revision.new_amount}
      </div>
      {revision.reason && <div style={{ fontSize: 11.5, color: "#6B5103", marginBottom: 8 }}>Reason: {revision.reason}</div>}
      <div style={{ fontSize: 11, color: "#6B5103", marginBottom: 8 }}>
        This isn't binding until you approve it — the current price stands until you respond.
      </div>
      {confirming ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11.5, color: C.gray }}>
            {confirming === "approve" ? "Approve the new price?" : "Decline and keep the current price?"}
          </span>
          <Btn size="sm" full={false} variant={confirming === "approve" ? "teal" : "danger"} disabled={working}
            onClick={() => resolve(confirming === "approve")}>Yes</Btn>
          <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirming(null)}>No</Btn>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" full={false} variant="danger" disabled={working} onClick={() => setConfirming("decline")}>Decline</Btn>
          <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => setConfirming("approve")}>Approve</Btn>
        </div>
      )}
    </div>
  );
}
