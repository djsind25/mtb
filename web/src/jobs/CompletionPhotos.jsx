import { useCallback, useEffect, useRef, useState } from "react";
import { C, nowStr } from "../theme";
import { loadCompletionPhotos, uploadCompletionPhoto, deleteCompletionPhoto } from "./data";

// Compact "7/31 2:45pm" stamp for the thumbnail/lightbox overlay — nowStr's fuller format ("Jul 31,
// 2:45 PM") is used for the lightbox caption line instead, where there's room for it.
function stampTime(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "").toLowerCase();
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// The on-image "stamp" burned onto the bottom of a photo — phase, timestamp, and geotag (or "no
// loc") — so each photo is self-descriptive on its own, independent of which upload button it
// came from or which section it's grouped under.
function PhotoStamp({ p }) {
  return (
    <div style={{
      position: "absolute", left: 0, right: 0, bottom: 0, padding: "3px 5px",
      background: "linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0))",
      display: "flex", flexDirection: "column", gap: 1, pointerEvents: "none",
    }}>
      <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 0.3, color: p.phase === "before" ? C.amber : C.teal }}>
        {p.phase === "before" ? "BEFORE" : "AFTER"}
      </span>
      <span style={{ fontSize: 7.5, color: "#fff" }}>
        {stampTime(p.created_at)} · {p.lat != null ? "📍" : "no loc"}
      </span>
    </div>
  );
}

// Shared before/after photo gallery with an inline lightbox (same pattern as JobPhotos), plus an
// optional hauler upload mode. When `haulerId` is passed the hauler can add/remove photos and the
// `onChange` callback fires after each mutation so the parent can re-check the "≥1 before + ≥1
// after" gate. Read-only for the customer/admin (no haulerId).
//
// Before/after photos share a single gallery, right next to the two upload buttons, rather than
// two separate sub-sections — each photo carries its own phase/time/geo stamp (see PhotoStamp
// above) so which button it came from is always visible on the photo itself.
export function CompletionPhotos({ jobId, haulerId, onChange, setToast }) {
  const [photos, setPhotos] = useState(null);
  const [openIndex, setOpenIndex] = useState(null);
  const [uploading, setUploading] = useState(null); // 'before' | 'after' | null
  const beforeInput = useRef(null);
  const afterInput = useRef(null);

  const reload = useCallback(async () => {
    try {
      const p = await loadCompletionPhotos(jobId);
      setPhotos(p);
      onChange?.(p);
    } catch {
      setPhotos([]);
    }
  }, [jobId, onChange]);

  useEffect(() => { reload(); }, [reload]);

  const flat = photos || [];
  const close = useCallback(() => setOpenIndex(null), []);
  const prev = useCallback(() => setOpenIndex(i => (i - 1 + flat.length) % flat.length), [flat.length]);
  const next = useCallback(() => setOpenIndex(i => (i + 1) % flat.length), [flat.length]);
  useEffect(() => {
    if (openIndex === null) return;
    function onKey(e) {
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openIndex, close, prev, next]);

  async function handleFiles(phase, fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name));
    if (files.length === 0) return;
    setUploading(phase);
    try {
      for (const file of files) {
        await uploadCompletionPhoto({ jobId, haulerId, phase, file });
      }
      await reload();
    } catch (e) {
      setToast?.(e.message || "Could not upload photo.");
    }
    setUploading(null);
  }

  async function removePhoto(p) {
    try {
      await deleteCompletionPhoto(p.id, p.storage_path);
      await reload();
    } catch (e) {
      setToast?.(e.message || "Could not remove photo.");
    }
  }

  if (photos === null) return null;
  const editable = !!haulerId;
  if (!editable && flat.length === 0) return null;

  const uploadTile = (phase, inputRef, label) => (
    <div key={`upload-${phase}`}>
      <input ref={inputRef} type="file" accept="image/*,.heic,.heif" multiple capture="environment" style={{ display: "none" }}
        onChange={e => { handleFiles(phase, e.target.files); e.target.value = ""; }} />
      <button onClick={() => inputRef.current?.click()} disabled={uploading === phase} style={{
        width: 84, height: 84, borderRadius: 8, border: `2px dashed ${C.line}`, background: "none",
        cursor: uploading === phase ? "default" : "pointer", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", color: C.gray, fontSize: 18, opacity: uploading === phase ? 0.6 : 1,
      }}>
        <span>{uploading === phase ? "…" : "📷"}</span>
        <span style={{ fontSize: 8.5 }}>{uploading === phase ? "Adding" : label}</span>
      </button>
    </div>
  );

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Photos</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
        {editable && uploadTile("before", beforeInput, "Before")}
        {editable && uploadTile("after", afterInput, "After")}
        {flat.map((p, i) => (
          <div key={p.id} style={{ position: "relative" }}>
            <button onClick={() => setOpenIndex(i)} style={{ padding: 0, border: "none", background: "none", cursor: "pointer", display: "block", position: "relative", width: 84, height: 84, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.line}` }}>
              <img src={p.url} alt={p.original_name || ""} style={{ width: 84, height: 84, objectFit: "cover", display: "block" }} />
              <PhotoStamp p={p} />
            </button>
            {editable && (
              <button onClick={() => removePhoto(p)} aria-label="Remove" style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: C.red, color: C.paper, border: "none", fontSize: 11, cursor: "pointer" }}>×</button>
            )}
          </div>
        ))}
      </div>
      {editable && flat.length === 0 && (
        <div style={{ fontSize: 11, color: C.gray, marginBottom: 6 }}>No photos yet — add at least one before and one after photo.</div>
      )}
      {editable && (
        <div style={{ fontSize: 10.5, color: C.gray, marginTop: -2 }}>
          📍 Each photo is time-stamped, and geotagged when location access is available.
        </div>
      )}

      {openIndex !== null && flat[openIndex] && (
        <div onClick={close} style={{ position: "fixed", inset: 0, background: "rgba(15,23,20,0.92)", zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <button onClick={close} aria-label="Close" style={{ position: "absolute", top: 18, right: 20, background: "none", border: "none", color: "#fff", fontSize: 30, cursor: "pointer", lineHeight: 1 }}>×</button>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
            {flat[openIndex].phase === "before" ? "Before" : "After"} · 🕐 {nowStr(flat[openIndex].created_at)} · {flat[openIndex].lat != null ? `📍 ${flat[openIndex].lat.toFixed(5)}, ${flat[openIndex].lng.toFixed(5)}` : "no location"}
          </div>
          <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: "100%", maxHeight: "78vh" }}>
            {flat.length > 1 && <button onClick={prev} aria-label="Previous" style={navBtnStyle}>‹</button>}
            <div style={{ position: "relative", display: "inline-block", maxWidth: "100%", maxHeight: "78vh" }}>
              <img src={flat[openIndex].url} alt="" style={{ maxWidth: "100%", maxHeight: "78vh", objectFit: "contain", borderRadius: 10, display: "block" }} />
              <div style={{
                position: "absolute", left: 0, right: 0, bottom: 0, padding: "8px 12px", borderRadius: "0 0 10px 10px",
                background: "linear-gradient(to top, rgba(0,0,0,0.75), rgba(0,0,0,0))", display: "flex", flexDirection: "column", gap: 2,
              }}>
                <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.5, color: flat[openIndex].phase === "before" ? C.amber : C.teal }}>
                  {flat[openIndex].phase === "before" ? "BEFORE" : "AFTER"}
                </span>
                <span style={{ fontSize: 11, color: "#fff" }}>
                  {stampTime(flat[openIndex].created_at)} · {flat[openIndex].lat != null ? `📍 ${flat[openIndex].lat.toFixed(5)}, ${flat[openIndex].lng.toFixed(5)}` : "no location"}
                </span>
              </div>
            </div>
            {flat.length > 1 && <button onClick={next} aria-label="Next" style={navBtnStyle}>›</button>}
          </div>
        </div>
      )}
    </div>
  );
}

const navBtnStyle = {
  background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", width: 44, height: 44,
  borderRadius: "50%", fontSize: 26, cursor: "pointer", flexShrink: 0, lineHeight: 1,
};
