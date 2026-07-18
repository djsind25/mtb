import { useCallback, useEffect, useRef, useState } from "react";
import { C } from "../theme";
import { Badge } from "../ui/Primitives";
import { loadCompletionPhotos, uploadCompletionPhoto, deleteCompletionPhoto } from "./data";

// Shared before/after photo viewer with an inline lightbox (same pattern as JobPhotos), plus an
// optional hauler upload mode. When `haulerId` is passed the hauler can add/remove photos and the
// `onChange` callback fires after each mutation so the parent can re-check the "≥1 before + ≥1
// after" gate. Read-only for the customer/admin (no haulerId).
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
  const bySection = { before: flat.filter(p => p.phase === "before"), after: flat.filter(p => p.phase === "after") };
  if (!editable && flat.length === 0) return null;

  const section = (phase, label) => {
    const list = bySection[phase];
    const inputRef = phase === "before" ? beforeInput : afterInput;
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>{label}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {list.map((p) => {
            const globalIdx = flat.indexOf(p);
            return (
              <div key={p.id} style={{ position: "relative" }}>
                <button onClick={() => setOpenIndex(globalIdx)} style={{ padding: 0, border: "none", background: "none", cursor: "pointer", display: "block" }}>
                  <img src={p.url} alt={p.original_name || ""} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}`, display: "block" }} />
                  <span style={{ position: "absolute", bottom: 3, left: 3, fontSize: 9, padding: "1px 4px", borderRadius: 5, background: p.lat != null ? "rgba(20,120,80,0.85)" : "rgba(90,90,90,0.85)", color: "#fff" }}>
                    {p.lat != null ? "📍 geo" : "no loc"}
                  </span>
                </button>
                {editable && (
                  <button onClick={() => removePhoto(p)} aria-label="Remove" style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: C.red, color: C.paper, border: "none", fontSize: 11, cursor: "pointer" }}>×</button>
                )}
              </div>
            );
          })}
          {editable && (
            <>
              <input ref={inputRef} type="file" accept="image/*,.heic,.heif" multiple capture="environment" style={{ display: "none" }}
                onChange={e => { handleFiles(phase, e.target.files); e.target.value = ""; }} />
              <button onClick={() => inputRef.current?.click()} disabled={uploading === phase} style={{
                width: 72, height: 72, borderRadius: 8, border: `2px dashed ${C.line}`, background: "none",
                cursor: uploading === phase ? "default" : "pointer", display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", color: C.gray, fontSize: 18, opacity: uploading === phase ? 0.6 : 1,
              }}>
                <span>{uploading === phase ? "…" : "+"}</span>
                <span style={{ fontSize: 9 }}>{uploading === phase ? "Adding" : "Add"}</span>
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 8 }}>
      {section("before", "Before photos")}
      {section("after", "After photos")}
      {editable && (
        <div style={{ fontSize: 10.5, color: C.gray, marginTop: -2 }}>
          📍 Photos capture your location when added (best-effort — allow location access when prompted).
        </div>
      )}

      {openIndex !== null && flat[openIndex] && (
        <div onClick={close} style={{ position: "fixed", inset: 0, background: "rgba(15,23,20,0.92)", zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <button onClick={close} aria-label="Close" style={{ position: "absolute", top: 18, right: 20, background: "none", border: "none", color: "#fff", fontSize: 30, cursor: "pointer", lineHeight: 1 }}>×</button>
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>
            {flat[openIndex].phase === "before" ? "Before" : "After"} · {flat[openIndex].lat != null ? `📍 ${flat[openIndex].lat.toFixed(5)}, ${flat[openIndex].lng.toFixed(5)}` : "no location"}
          </div>
          <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: "100%", maxHeight: "78vh" }}>
            {flat.length > 1 && <button onClick={prev} aria-label="Previous" style={navBtnStyle}>‹</button>}
            <img src={flat[openIndex].url} alt="" style={{ maxWidth: "100%", maxHeight: "78vh", objectFit: "contain", borderRadius: 10 }} />
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
