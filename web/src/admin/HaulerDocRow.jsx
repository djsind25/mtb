import { useState } from "react";
import { C } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { reviewHaulerDocument } from "./data";

const DOC_LABELS = { license: "Business license", insurance: "Insurance" };
const STATUS_STYLE = {
  pending: { color: C.amber, bg: C.amberLight },
  approved: { color: C.teal, bg: C.tealLight },
  rejected: { color: C.red, bg: C.redLight },
  expired: { color: C.red, bg: C.redLight },
};

export function HaulerDocRow({ doc, onChanged, setToast }) {
  const [working, setWorking] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const pending = doc.status === "pending";

  async function approve() {
    setWorking(true);
    try {
      await reviewHaulerDocument(doc.id, true);
      setToast(`${doc.haulerName || "Hauler"}'s ${DOC_LABELS[doc.doc_type]} approved.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not approve document.");
    }
    setWorking(false);
  }

  async function reject() {
    setWorking(true);
    try {
      await reviewHaulerDocument(doc.id, false, note.trim() || null);
      setToast(`${doc.haulerName || "Hauler"}'s ${DOC_LABELS[doc.doc_type]} rejected.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not reject document.");
    }
    setWorking(false);
    setRejecting(false);
  }

  const status = STATUS_STYLE[doc.status] || STATUS_STYLE.pending;

  return (
    <div style={{
      border: `1px solid ${pending ? C.amber + "66" : C.line}`, background: pending ? C.amberLight : C.paper,
      borderRadius: 10, padding: "10px 12px", display: "grid", gap: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>
          {doc.haulerName || "Unknown hauler"} · {DOC_LABELS[doc.doc_type] || doc.doc_type}
        </span>
        <Badge color={status.color} bg={status.bg}>{doc.status}</Badge>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray }}>
        {doc.url && <a href={doc.url} target="_blank" rel="noreferrer" style={{ color: C.teal }}>{doc.original_name || "View file"}</a>}
        {" · "}Expires {new Date(doc.expires_at + "T00:00:00").toLocaleDateString()}
        {" · "}Submitted {new Date(doc.uploaded_at).toLocaleDateString()}
      </div>
      {doc.status === "rejected" && doc.reviewer_note && (
        <div style={{ fontSize: 11.5, color: C.red }}>Note: {doc.reviewer_note}</div>
      )}

      {pending && (
        rejecting ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason (optional)"
              style={{ flex: 1, minWidth: 140, border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "6px 10px", fontSize: 12 }} />
            <Btn size="sm" full={false} variant="danger" disabled={working} onClick={reject}>Confirm reject</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setRejecting(false)}>Cancel</Btn>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" full={false} variant="danger" disabled={working} onClick={() => setRejecting(true)}>Reject</Btn>
            <Btn size="sm" full={false} variant="teal" disabled={working} onClick={approve}>Approve</Btn>
          </div>
        )
      )}
    </div>
  );
}
