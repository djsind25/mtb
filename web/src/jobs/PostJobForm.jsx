import { useRef, useState } from "react";
import { C, sans, SHADOW } from "../theme";
import { Field, Btn } from "../ui/Primitives";
import { TimelinePicker } from "./TimelinePicker";

export function PostJobForm({ onCancel, onSubmit, submitting }) {
  const [serviceType, setServiceType] = useState("removal"); // removal | rental
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [zip, setZip] = useState("");
  const [photos, setPhotos] = useState([]); // [{ file, url }]
  const [dumpsterType, setDumpsterType] = useState("rolloff");
  const [rentalStartDate, setRentalStartDate] = useState("");
  const [rentalEndDate, setRentalEndDate] = useState("");
  const [timeline, setTimeline] = useState(null);
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

  const isRental = serviceType === "rental";
  const canSubmit = !submitting && zip && timeline && (
    isRental ? (dumpsterType && rentalStartDate && rentalEndDate)
      : (title && photos.length > 0)
  );

  function submit() {
    if (isRental) {
      const label = dumpsterType === "trailer" ? "Trailer" : "Roll-off dumpster";
      onSubmit({
        serviceType: "rental", zip, dumpsterType, rentalStartDate, rentalEndDate, timeline,
        title: `${label} rental, ${rentalStartDate} to ${rentalEndDate}`,
        description: null, photos: photos.map(p => p.file),
      });
    } else {
      onSubmit({ serviceType: "removal", title, description, zip, timeline, photos: photos.map(p => p.file) });
    }
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 18, padding: 18, marginBottom: 16, boxShadow: SHADOW }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, background: C.sandWarm, borderRadius: 14, padding: 3 }}>
        {[{ id: "removal", label: "Junk removal" }, { id: "rental", label: "Dumpster / trailer rental" }].map(t => (
          <button key={t.id} onClick={() => setServiceType(t.id)} style={{
            flex: 1, padding: "8px", borderRadius: 10, border: "none", cursor: "pointer",
            background: serviceType === t.id ? C.paper : "transparent", fontWeight: 700, fontSize: 13,
            color: serviceType === t.id ? C.pineDeep : C.gray, fontFamily: sans,
          }}>{t.label}</button>
        ))}
      </div>

      {isRental ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 7 }}>What do you need? <span style={{ color: C.red }}>*</span></label>
            <div style={{ display: "flex", gap: 8 }}>
              {[{ id: "rolloff", label: "🗑️ Roll-off dumpster" }, { id: "trailer", label: "🚛 Trailer" }].map(o => (
                <button key={o.id} onClick={() => setDumpsterType(o.id)} type="button" style={{
                  flex: 1, border: `1.5px solid ${dumpsterType === o.id ? C.green : C.line}`, borderRadius: 14,
                  background: dumpsterType === o.id ? C.tealLight : C.paper, padding: "12px 10px",
                  cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.ink, fontFamily: sans,
                }}>{o.label}</button>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Field label="Drop-off date" value={rentalStartDate} onChange={setRentalStartDate} type="date" required />
            <Field label="Pickup date" value={rentalEndDate} onChange={setRentalEndDate} type="date" required />
          </div>
        </>
      ) : (
        <>
          <Field label="Job title" value={title} onChange={setTitle} placeholder="Old couch + mattresses" required />
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What needs to go, roughly how much, any access notes…"
              style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 12, padding: "10px 13px", fontSize: 14, fontFamily: sans, outline: "none", minHeight: 80, resize: "vertical" }} />
            <div style={{ fontSize: 11.5, color: C.teal, marginTop: 5, display: "flex", gap: 5 }}>
              <span>📏</span>
              <span>Tip: approximate measurements and weight (e.g. "couch, ~150 lbs, about 7ft long") help haulers bid accurately.</span>
            </div>
          </div>
        </>
      )}

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>
          Photos {!isRental && <span style={{ color: C.red }}>*</span>} <span style={{ fontWeight: 400, color: C.gray }}>{isRental ? "— optional" : "— at least 1 required"}</span>
        </label>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative", width: 64, height: 64 }}>
              <img src={p.url} alt={p.file.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 12, border: `1px solid ${C.line}` }} />
              <button onClick={() => removePhoto(i)} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: C.red, color: C.paper, border: "none", fontSize: 11, cursor: "pointer" }}>×</button>
            </div>
          ))}
          <button onClick={() => fileInputRef.current?.click()} style={{
            width: 64, height: 64, borderRadius: 12, border: `2px dashed ${C.line}`, background: "none",
            cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            color: C.gray, fontSize: 18,
          }}>
            <span>+</span>
            <span style={{ fontSize: 9 }}>Add</span>
          </button>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 7 }}>
          How soon do you need this done? <span style={{ color: C.red }}>*</span>
        </label>
        <TimelinePicker value={timeline} onChange={setTimeline} />
      </div>

      <Field label="ZIP code" value={zip} onChange={setZip} placeholder="60491" required />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!canSubmit} onClick={submit}>
          {submitting ? "Posting…" : isRental ? "Post rental request" : "Post job"}
        </Btn>
      </div>
    </div>
  );
}
