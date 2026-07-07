import { useRef, useState } from "react";
import { C, sans } from "../theme";
import { Field, Btn } from "../ui/Primitives";

export function PostJobForm({ onCancel, onSubmit, submitting }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [zip, setZip] = useState("");
  const [photos, setPhotos] = useState([]); // [{ file, url }]
  const fileInputRef = useRef(null);

  function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
    const newPhotos = files.map(f => ({ file: f, url: URL.createObjectURL(f) }));
    setPhotos(p => [...p, ...newPhotos]);
  }
  function removePhoto(idx) {
    setPhotos(p => {
      const copy = [...p];
      URL.revokeObjectURL(copy[idx].url);
      copy.splice(idx, 1);
      return copy;
    });
  }

  const canSubmit = title && zip && photos.length > 0 && !submitting;

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <Field label="Job title" value={title} onChange={setTitle} placeholder="Old couch + mattresses" required />

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What needs to go, roughly how much, any access notes…"
          style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "10px 13px", fontSize: 14, fontFamily: sans, outline: "none", minHeight: 80, resize: "vertical" }} />
        <div style={{ fontSize: 11.5, color: C.teal, marginTop: 5, display: "flex", gap: 5 }}>
          <span>📏</span>
          <span>Tip: approximate measurements (e.g. "couch is about 7ft long") help haulers bid accurately.</span>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>
          Photos <span style={{ color: C.red }}>*</span> <span style={{ fontWeight: 400, color: C.gray }}>— at least 1 required</span>
        </label>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative", width: 64, height: 64 }}>
              <img src={p.url} alt={p.file.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />
              <button onClick={() => removePhoto(i)} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: C.red, color: C.paper, border: "none", fontSize: 11, cursor: "pointer" }}>×</button>
            </div>
          ))}
          <button onClick={() => fileInputRef.current?.click()} style={{
            width: 64, height: 64, borderRadius: 8, border: `2px dashed ${C.line}`, background: "none",
            cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            color: C.gray, fontSize: 18,
          }}>
            <span>+</span>
            <span style={{ fontSize: 9 }}>Add</span>
          </button>
        </div>
      </div>

      <Field label="ZIP code" value={zip} onChange={setZip} placeholder="60491" required />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!canSubmit} onClick={() => onSubmit({ title, description, zip, photos: photos.map(p => p.file) })}>
          {submitting ? "Posting…" : "Post job"}
        </Btn>
      </div>
    </div>
  );
}
