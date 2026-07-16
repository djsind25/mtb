import { useState } from "react";
import { C, expiryLabel, timelineMeta } from "../theme";
import { Badge, Field, Btn } from "../ui/Primitives";
import { JobPhotos } from "./JobPhotos";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function HaulerJobCard({ job, alreadyBid, onBid }) {
  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isRental = job.service_type === "rental";
  const timeline = timelineMeta(job.timeline);

  async function submit() {
    setSubmitting(true);
    await onBid(job.id, amount, note);
    setSubmitting(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => setExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", padding: 16, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14.5, color: C.pineDeep, marginBottom: 4 }}>{job.title}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {isRental && <Badge color={C.teal} bg={C.tealLight}>🗑️ {job.dumpster_type === "trailer" ? "Trailer" : "Roll-off"} rental</Badge>}
              <span style={{ fontSize: 11.5, color: C.gray }}>📍 ZIP {job.zip} · {job.bid_count} bids so far</span>
              <Badge color={C.gray} bg={C.grayLight}>{expiryLabel(job.expires_at)}</Badge>
              {typeof job.distance_mi === "number" && <Badge color={C.teal} bg={C.tealLight}>📏 {job.distance_mi < 1 ? "<1" : Math.round(job.distance_mi)} mi away</Badge>}
              {job.distance_mi === null && <Badge color={C.gray} bg={C.grayLight}>Distance unknown</Badge>}
              {timeline && <Badge color={timeline.color} bg={timeline.bg}>{timeline.urgent ? "⚡ " : "⏱ "}{timeline.label}</Badge>}
              {job.photo_count > 0 && <Badge color={C.teal} bg={C.tealLight}>📷 {job.photo_count} photo{job.photo_count !== 1 ? "s" : ""} attached</Badge>}
            </div>
          </div>
          <span style={{ color: C.gray }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: 16 }}>
          <JobPhotos jobId={job.id} />
          {isRental ? (
            <div style={{ background: C.sand, borderRadius: 8, padding: "10px 12px", marginBottom: 14, fontSize: 13, color: C.ink }}>
              <div><strong>{job.dumpster_type === "trailer" ? "Trailer" : "Roll-off dumpster"}</strong></div>
              <div style={{ color: C.gray, marginTop: 2 }}>Needed {formatDate(job.rental_start_date)} – {formatDate(job.rental_end_date)}</div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: C.gray, marginBottom: 14, lineHeight: 1.5 }}>{job.description || "No description provided."}</p>
          )}
          {timeline && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, marginBottom: 14, padding: "9px 12px",
              borderRadius: 8, background: timeline.urgent ? C.redLight : C.sand,
              border: `1px solid ${timeline.urgent ? C.red + "55" : C.line}`,
            }}>
              <span style={{ fontSize: 13 }}>{timeline.urgent ? "⚡" : "⏱"}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: timeline.urgent ? C.red : C.ink }}>
                Customer needs this: {timeline.label}
              </span>
            </div>
          )}
          {alreadyBid ? (
            <Badge color={C.teal} bg={C.tealLight}>✓ You already bid on this job</Badge>
          ) : (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <Field label="Your bid ($)" value={amount} onChange={setAmount} type="number" placeholder="175" />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Message to customer</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Why pick you?" style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "10px 13px", fontSize: 13.5, fontFamily: "inherit", outline: "none", minHeight: 60, resize: "vertical" }} />
              </div>
              <div style={{ fontSize: 11, color: C.gray, marginBottom: 10 }}>
                Your bid stays open for the customer to accept for {isRental ? 30 : 14} days, unless you renew it. This is a sealed bid — other haulers can't see your price.
              </div>
              <Btn disabled={!amount || submitting} onClick={submit}>{submitting ? "Submitting…" : "Submit bid"}</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
