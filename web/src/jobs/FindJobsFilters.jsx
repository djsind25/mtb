import { useState } from "react";
import { C, TIMELINE_OPTIONS, JOB_CATEGORY_OPTIONS, JOB_SORT_OPTIONS } from "../theme";
import { Btn } from "../ui/Primitives";

const DISTANCE_BANDS = [10, 25, 50];

function chipStyle(active) {
  return {
    border: `1.5px solid ${active ? C.green : C.line}`, borderRadius: 20,
    background: active ? C.tealLight : C.paper, padding: "5px 12px",
    cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: C.ink, fontFamily: "inherit",
  };
}

function toggleInSet(arr, id) {
  return arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id];
}

export function FindJobsFilters({
  sort, onSortChange,
  distanceBand, onDistanceBandChange, maxRadiusMi,
  timelines, onTimelinesChange,
  jobTypes, onJobTypesChange,
  density, onDensityChange,
  showDismissed, onShowDismissedChange, dismissedCount,
  matchCount, totalCount,
  savedViewActive, onSaveDefault, onResetToRadius,
}) {
  const [open, setOpen] = useState(false);
  const bands = DISTANCE_BANDS.filter(b => b <= maxRadiusMi);
  const filtersActiveCount = (distanceBand ? 1 : 0) + (timelines.length > 0 ? 1 : 0) + (jobTypes.length > 0 ? 1 : 0);

  function clearAll() {
    onDistanceBandChange(null);
    onTimelinesChange([]);
    onJobTypesChange([]);
  }

  return (
    <div style={{ marginBottom: 14 }}>
      {savedViewActive && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap",
          background: C.tealLight, border: `1px solid ${C.green}55`, borderRadius: 8, padding: "8px 12px", marginBottom: 10,
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.teal }}>📌 Showing your saved view</span>
          <button onClick={onResetToRadius} style={{ background: "none", border: "none", color: C.teal, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>
            Reset to all jobs in my radius
          </button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: open ? 10 : 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setOpen(o => !o)} style={{
            border: `1.5px solid ${C.line}`, borderRadius: 8, background: C.paper, padding: "6px 12px",
            cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: C.pineDeep, fontFamily: "inherit",
          }}>
            🔎 Filters {filtersActiveCount > 0 ? `(${filtersActiveCount})` : ""} {open ? "▲" : "▼"}
          </button>
          <select value={sort} onChange={e => onSortChange(e.target.value)} style={{
            border: `1.5px solid ${C.line}`, borderRadius: 8, background: C.paper, padding: "6px 10px",
            cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: C.ink, fontFamily: "inherit",
          }}>
            {JOB_SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
          </select>
          <div style={{ display: "flex", border: `1.5px solid ${C.line}`, borderRadius: 8, overflow: "hidden" }}>
            {[{ id: "compact", label: "☰" }, { id: "card", label: "▤" }].map(d => (
              <button key={d.id} onClick={() => onDensityChange(d.id)} title={d.id === "compact" ? "Compact rows" : "Full cards"} style={{
                border: "none", background: density === d.id ? C.tealLight : C.paper, padding: "6px 10px",
                cursor: "pointer", fontSize: 13, color: density === d.id ? C.teal : C.gray,
              }}>{d.label}</button>
            ))}
          </div>
        </div>
        <span style={{ fontSize: 11.5, color: C.gray }}>
          Showing {matchCount} of {totalCount} job{totalCount === 1 ? "" : "s"}
        </span>
      </div>

      {open && (
        <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.03em" }}>Distance</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <button onClick={() => onDistanceBandChange(null)} style={chipStyle(!distanceBand)}>All ({maxRadiusMi} mi)</button>
              {bands.map(b => (
                <button key={b} onClick={() => onDistanceBandChange(b)} style={chipStyle(distanceBand === b)}>Within {b} mi</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.03em" }}>Timeline</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {TIMELINE_OPTIONS.map(o => (
                <button key={o.id} onClick={() => onTimelinesChange(toggleInSet(timelines, o.id))} style={chipStyle(timelines.includes(o.id))}>{o.label}</button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.gray, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.03em" }}>Job type</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {JOB_CATEGORY_OPTIONS.map(o => (
                <button key={o.id} onClick={() => onJobTypesChange(toggleInSet(jobTypes, o.id))} style={chipStyle(jobTypes.includes(o.id))}>{o.label}</button>
              ))}
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: C.ink, marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={showDismissed} onChange={e => onShowDismissedChange(e.target.checked)} />
            Show dismissed jobs {dismissedCount > 0 ? `(${dismissedCount})` : ""}
          </label>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", borderTop: `1px solid ${C.line}`, paddingTop: 10 }}>
            {filtersActiveCount > 0 && (
              <button onClick={clearAll} style={{ background: "none", border: "none", color: C.teal, fontSize: 11.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                {filtersActiveCount} filter{filtersActiveCount === 1 ? "" : "s"} active · clear all
              </button>
            )}
            <div style={{ flex: 1 }} />
            <Btn size="sm" full={false} variant="ghost" onClick={onSaveDefault}>💾 Save as my default</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
