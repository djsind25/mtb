import { useRef, useState } from "react";
import { C, sans, fullDateLabel } from "../theme";
import { Btn, Badge } from "../ui/Primitives";
import { submitHaulerDocument } from "./data";
import { VERTICAL } from "../config/vertical";

const DOC_LABELS = VERTICAL.vetting.docLabels;

// Defense-in-depth only — the `accept` attribute on the file input isn't enforced by browsers, and
// there's no server-side size/type limit on the hauler-documents bucket today, so this is the only
// gate a bad-faith upload would hit before reaching storage.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ["application/pdf"];
function isAllowedFile(file) {
  return file.type.startsWith("image/") || ALLOWED_TYPES.includes(file.type);
}

const STATUS_STYLE = {
  pending: { color: C.amber, bg: C.amberLight, label: "Pending review" },
  approved: { color: C.teal, bg: C.tealLight, label: "Approved" },
  rejected: { color: C.red, bg: C.redLight, label: "Rejected" },
  expired: { color: C.red, bg: C.redLight, label: "Expired" },
};

// Read-only — a document can never be deleted once submitted, so this only ever displays it.
function DocEntry({ doc }) {
  const status = STATUS_STYLE[doc.status];
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px", display: "grid", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 11.5, color: C.gray }}>
          {doc.url && <a href={doc.url} target="_blank" rel="noreferrer" style={{ color: C.teal, fontWeight: 600 }}>{doc.original_name || "View file"}</a>}
          {doc.original_name && doc.url ? " · " : ""}
          Expires {fullDateLabel(doc.expires_at + "T00:00:00")}
        </span>
        <Badge color={status.color} bg={status.bg}>{status.label}</Badge>
      </div>
      {doc.status === "rejected" && doc.reviewer_note && (
        <div style={{ fontSize: 11.5, color: C.red }}>Reviewer note: {doc.reviewer_note}</div>
      )}
    </div>
  );
}

function UploadForm({ docType, haulerId, onSubmitted, setToast }) {
  const fileInputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!file) { setToast("Choose a file first."); return; }
    if (!isAllowedFile(file)) { setToast("Only images or PDFs are accepted."); return; }
    if (file.size > MAX_FILE_BYTES) { setToast("File is too large — 10 MB max."); return; }
    if (!expiresAt) { setToast("Set an expiration date."); return; }
    setSubmitting(true);
    try {
      await submitHaulerDocument({ haulerId, docType, file, expiresAt });
      setFile(null);
      setExpiresAt("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      setToast(`${DOC_LABELS[docType]} submitted for review.`);
      onSubmitted();
    } catch (e) {
      setToast(e.message || "Could not submit document.");
    }
    setSubmitting(false);
  }

  return (
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
        {submitting ? "Submitting…" : "Add document"}
      </Btn>
    </div>
  );
}

function DocTypeSection({ docType, docs, haulerId, onSubmitted, setToast }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{DOC_LABELS[docType]}</span>
        {docs.length === 0 && <Badge color={C.gray} bg={C.grayLight}>Not submitted</Badge>}
      </div>
      {docs.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {docs.map(doc => <DocEntry key={doc.id} doc={doc} />)}
        </div>
      )}
      <UploadForm docType={docType} haulerId={haulerId} onSubmitted={onSubmitted} setToast={setToast} />
    </div>
  );
}

export function HaulerDocuments({ haulerId, documents, onChanged, setToast }) {
  return (
    <section>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Verification documents</div>
      <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 12 }}>
        {VERTICAL.vetting.intro}
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        <DocTypeSection docType="license" docs={documents.license || []} haulerId={haulerId} onSubmitted={onChanged} setToast={setToast} />
        <DocTypeSection docType="insurance" docs={documents.insurance || []} haulerId={haulerId} onSubmitted={onChanged} setToast={setToast} />
      </div>
    </section>
  );
}
