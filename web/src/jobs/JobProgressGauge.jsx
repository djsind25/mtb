import { C } from "../theme";

// Five stages spanning a job's whole lifecycle, from posting through completion. Percent values
// drive both the needle angle and the linear bar below it; colors match the reference fuel-gauge
// mockup (red → orange → yellow → teal → green) so "further along" always reads as "closer to
// green" regardless of which of the two views (job card vs. chat panel) is showing it.
const STAGES = [
  { id: "posted", label: "Job Posted", percent: 10, color: "#E5484D" },
  { id: "bids", label: "Receiving Bids", percent: 30, color: "#F5A623" },
  { id: "booked", label: "Hauler Locked In", percent: 55, color: "#F0C93B" },
  { id: "haulerDone", label: "Marked Complete — Awaiting Your OK", percent: 80, color: "#63C6A6" },
  { id: "complete", label: "Job Complete", percent: 100, color: "#2E8B57" },
];

// Maps a job's real fields to one of the five stages above. A chat only ever exists once a bid is
// accepted, so JobStatusPanel (which has no job.status of its own) can just pass status: "booked"
// and skip straight past the first two stages.
export function stageForJob({ status, completed, haulerDoneAt, bidCount = 0 }) {
  if (completed) return STAGES[4];
  if (haulerDoneAt) return STAGES[3];
  if (status === "booked") return STAGES[2];
  if (bidCount > 0) return STAGES[1];
  return STAGES[0];
}

function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

// Semicircle arc from startDeg (left, 180°) sweeping over the top down to endDeg (right, 0°).
function arcPath(cx, cy, r, startDeg, endDeg) {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const largeArc = Math.abs(startDeg - endDeg) > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

// One band per stage, each 36° of the 180° sweep, colors matching STAGES above.
const BANDS = [
  { from: 180, to: 144, color: "#E5484D" },
  { from: 144, to: 108, color: "#F5A623" },
  { from: 108, to: 72, color: "#F0C93B" },
  { from: 72, to: 36, color: "#63C6A6" },
  { from: 36, to: 0, color: "#2E8B57" },
];

export function JobProgressGauge({ stage, compact = false }) {
  const size = compact ? 130 : 190;
  const cx = size / 2;
  const cy = size / 2 - 4;
  const r = size * 0.4;
  const strokeWidth = compact ? 9 : 13;
  const needleAngle = 180 - (stage.percent / 100) * 180;
  const needleTip = polar(cx, cy, r - strokeWidth - 4, needleAngle);

  return (
    <div>
      <svg viewBox={`0 0 ${size} ${size / 2 + 16}`} width="100%" style={{ maxWidth: size, display: "block", margin: "0 auto" }}>
        {BANDS.map((b, i) => (
          <path key={i} d={arcPath(cx, cy, r, b.from, b.to)} stroke={b.color} strokeWidth={strokeWidth} fill="none" opacity={0.85} />
        ))}
        <line x1={cx} y1={cy} x2={needleTip.x} y2={needleTip.y} stroke={C.ink} strokeWidth={compact ? 2.5 : 3} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={compact ? 5 : 6.5} fill={C.ink} />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: compact ? -2 : 4, marginBottom: 4 }}>
        <span style={{ fontSize: compact ? 10 : 11.5, color: C.gray, fontWeight: 600 }}>Progress</span>
        <span style={{ fontSize: compact ? 11 : 13, fontWeight: 700, color: C.pineDeep, fontVariantNumeric: "tabular-nums" }}>{stage.percent}%</span>
      </div>
      <div style={{ height: compact ? 6 : 8, borderRadius: 99, background: C.grayLight, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${stage.percent}%`, background: stage.color, borderRadius: 99, transition: "width 0.3s" }} />
      </div>
      <div style={{
        marginTop: 8, display: "inline-block", fontSize: compact ? 10 : 11.5, fontWeight: 700, color: C.pineDeep,
        background: C.tealLight, borderRadius: 20, padding: "3px 10px",
      }}>
        Current Stage: {stage.label}
      </div>
    </div>
  );
}
