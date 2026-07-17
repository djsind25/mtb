import { useRef, useState } from "react";
import { C, sans } from "../theme";
import { Btn, Badge } from "../ui/Primitives";
import { submitHaulerDocument } from "./data";

const DOC_LABELS = { license: "Business license", insurance: "Insurance" };

const STATUS_STYLE = {
  pending: { color: C.amber, bg: C.amberLight, label: "Pending review" },
  approved: { color: C.teal, bg: C.tealLight, label: "Approved" },
  rejected: { color: C.red, bg: C.redLight, label: "Rejected" },
  expired: { color: C.red, bg: C.redLight, label: "Expired" },
};

function DocCard({ docType, doc, haulerId, onSubmitted, setToast }) {
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const status = doc && STATUS_STYLE[doc.status];

  async function submit() {
    if (!file) { setToast("Choose a file first."); return; }
    if (!expiresAt) { setToast("Set an expiration date."); return; }
    setSubmitting(true);
    try {
      await submitHaulerDocument({ haulerId, docType, file, expiresAt });
      setFile(null);
      setExpiresAt("");
      setToast(`${DOC_LABELS[docType]} submitted for review.`);
      onSubmitted();
    } catch (e) {
      setToast(e.message || "Could not submit document.");
    }
    setSubmitting(false);
  }

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{DOC_LABELS[docType]}</span>
        {status ? <Badge color={status.color} bg={status.bg}>{status.label}</Badge> : <Badge color={C.gray} bg={C.grayLight}>Not submitted</Badge>}
      </div>

      {doc && (
        <div style={{ fontSize: 11.5, color: C.gray }}>
          {doc.url && <a href={doc.url} target="_blank" rel="noreferrer" style={{ color: C.teal }}>{doc.original_name || "View file"}</a>}
          {doc.original_name && doc.url ? " · " : ""}
          Expires {new Date(doc.expires_at + "T00:00:00").toLocaleDateString()}
        </div>
      )}
      {doc?.status === "rejected" && doc.reviewer_note && (
        <div style={{ fontSize: 11.5, color: C.red }}>Reviewer note: {doc.reviewer_note}</div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input ref={fileInputRef} type="file" accept="image/*,.pdf" style={{ display: "none" }}
          onChange={e => setFile(e.target.files[0] || null)} />
        <button onClick={() => fileInputRef.current?.click()} style={{
          background: "none", border: `1.5px dashed ${C.line}`, borderRadius: 8, padding: "8px 12px",
          fontSize: 12, color: C.gray, cursor: "pointer", fontFamily: sans,
        }}>{file ? file.name : "Choose file…"}</button>
        <input type="date" value={expiresAt} onChange={e => setExpiresAt(e.target.value)}
          style={{ border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", fontSize: 12.5, fontFamily: sans, color: C.ink }} />
        <Btn size="sm" full={false} onClick={submit} disabled={submitting}>
          {submitting ? "Submitting…" : doc ? "Replace" : "Submit"}
        </Btn>
      </div>
    </div>
  );
}

export function HaulerDocuments({ haulerId, documents, onChanged, setToast }) {
  return (
    <section>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Verification documents</div>
      <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 12 }}>
        Both a current license and insurance must be approved before you can bid on jobs. Submitting a
        new document resets its status to pending until an admin reviews it.
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        <DocCard docType="license" doc={documents.license} haulerId={haulerId} onSubmitted={onChanged} setToast={setToast} />
        <DocCard docType="insurance" doc={documents.insurance} haulerId={haulerId} onSubmitted={onChanged} setToast={setToast} />
      </div>
    </section>
  );
}
