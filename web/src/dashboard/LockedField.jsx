import { useState } from "react";
import { C, sans } from "../theme";
import { Btn, Badge } from "../ui/Primitives";

const inputStyle = {
  width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
  padding: "9px 12px", fontSize: 13.5, fontFamily: sans, outline: "none", color: C.ink, marginBottom: 8,
};

// business_name and the vetting-credential fields can't be saved directly — editing one queues a
// profile_change_requests row instead, and stays "pending review" (no further edits possible)
// until an admin approves or denies it.
export function LockedField({ label, value, pendingRequest, onSubmit, submitting }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const [reason, setReason] = useState("");

  if (pendingRequest) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>{label}</div>
        <div style={{ fontSize: 13.5, color: C.gray, marginBottom: 4 }}>{value || "—"}</div>
        <Badge color={C.amber} bg={C.amberLight}>Change requested — pending review</Badge>
        <div style={{ fontSize: 11, color: C.gray, marginTop: 4 }}>Requested: {pendingRequest.requested_value}</div>
      </div>
    );
  }

  if (!editing) {
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>{label}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13.5, color: C.ink }}>{value || "—"}</span>
          <button onClick={() => { setDraft(value || ""); setEditing(true); }} style={{
            background: "none", border: "none", color: C.teal, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0,
          }}>
            Request change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>{label}</div>
      <input value={draft} onChange={e => setDraft(e.target.value)} style={inputStyle} />
      <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional)" style={inputStyle} />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn size="sm" full={false} variant="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
        <Btn size="sm" full={false} disabled={!draft.trim() || submitting} onClick={async () => {
          await onSubmit(draft.trim(), reason.trim());
          setEditing(false);
        }}>
          {submitting ? "Submitting…" : "Submit for review"}
        </Btn>
      </div>
    </div>
  );
}
