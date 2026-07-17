import { useCallback, useEffect, useState } from "react";
import { C } from "../theme";
import { loadJobPhotos } from "./data";

export function JobPhotos({ jobId }) {
  const [photos, setPhotos] = useState(null);
  const [openIndex, setOpenIndex] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadJobPhotos(jobId).then(p => { if (!cancelled) setPhotos(p); }).catch(() => setPhotos([]));
    return () => { cancelled = true; };
  }, [jobId]);

  const close = useCallback(() => setOpenIndex(null), []);
  const prev = useCallback(() => setOpenIndex(i => (i - 1 + photos.length) % photos.length), [photos]);
  const next = useCallback(() => setOpenIndex(i => (i + 1) % photos.length), [photos]);

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

  if (!photos || photos.length === 0) return null;

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {photos.map((p, i) => (
          <button key={p.id} onClick={() => setOpenIndex(i)} style={{ padding: 0, border: "none", background: "none", cursor: "pointer" }}>
            <img src={p.url} alt={p.original_name || ""} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}`, display: "block" }} />
          </button>
        ))}
      </div>

      {openIndex !== null && (
        <div onClick={close} style={{
          position: "fixed", inset: 0, background: "rgba(15,23,20,0.92)", zIndex: 2000,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <button onClick={close} aria-label="Close" style={{
            position: "absolute", top: 18, right: 20, background: "none", border: "none", color: "#fff",
            fontSize: 30, cursor: "pointer", lineHeight: 1,
          }}>×</button>

          {photos.length > 1 && (
            <div style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", marginBottom: 10 }}>{openIndex + 1} / {photos.length}</div>
          )}

          <div onClick={e => e.stopPropagation()} style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: "100%", maxHeight: "78vh" }}>
            {photos.length > 1 && (
              <button onClick={prev} aria-label="Previous photo" style={navBtnStyle}>‹</button>
            )}
            <img src={photos[openIndex].url} alt={photos[openIndex].original_name || ""} style={{ maxWidth: "100%", maxHeight: "78vh", objectFit: "contain", borderRadius: 10 }} />
            {photos.length > 1 && (
              <button onClick={next} aria-label="Next photo" style={navBtnStyle}>›</button>
            )}
          </div>

          {photos.length > 1 && (
            <div onClick={e => e.stopPropagation()} style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap", justifyContent: "center", maxWidth: "90vw" }}>
              {photos.map((p, i) => (
                <button key={p.id} onClick={() => setOpenIndex(i)} style={{
                  padding: 0, cursor: "pointer", background: "none", borderRadius: 8,
                  border: i === openIndex ? `2px solid ${C.teal}` : "2px solid transparent",
                }}>
                  <img src={p.url} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, opacity: i === openIndex ? 1 : 0.6, display: "block" }} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

const navBtnStyle = {
  background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", width: 44, height: 44,
  borderRadius: "50%", fontSize: 26, cursor: "pointer", flexShrink: 0, lineHeight: 1,
};
