import { useEffect, useState } from "react";
import { C } from "../theme";
import { loadJobPhotos } from "./data";

export function JobPhotos({ jobId }) {
  const [photos, setPhotos] = useState(null);

  useEffect(() => {
    let cancelled = false;
    loadJobPhotos(jobId).then(p => { if (!cancelled) setPhotos(p); }).catch(() => setPhotos([]));
    return () => { cancelled = true; };
  }, [jobId]);

  if (!photos || photos.length === 0) return null;

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
      {photos.map(p => (
        <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
          <img src={p.url} alt={p.original_name || ""} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />
        </a>
      ))}
    </div>
  );
}
