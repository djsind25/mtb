import { useState } from "react";
import { C, sans, nowStr, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { dismissLead } from "./data";

const CATEGORY_META = {
  no_bids: { label: "No bids yet", color: C.amber, bg: C.amberLight },
  no_acceptance: { label: "Bids, no acceptance", color: C.teal, bg: C.tealLight },
  stalled_coordination: { label: "Stalled coordination", color: C.red, bg: C.redLight },
  expired_unbooked: { label: "Expired without booking", color: C.gray, bg: C.grayLight },
  abandoned_signup: { label: "Abandoned signup", color: C.gray, bg: C.grayLight },
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "no_bids", label: "No bids yet" },
  { id: "no_acceptance", label: "Bids, no acceptance" },
  { id: "stalled_coordination", label: "Stalled coordination" },
  { id: "expired_unbooked", label: "Expired" },
  { id: "abandoned_signup", label: "Abandoned signup" },
];

function Row({ item, onChanged, setToast, readOnly }) {
  const [dismissing, setDismissing] = useState(false);
  const meta = CATEGORY_META[item.category];

  async function dismiss(status) {
    setDismissing(true);
    try {
      await dismissLead(item.category, item.refId, status);
      setToast(status === "resolved" ? "Marked resolved." : "Marked reviewed.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update this lead.");
    }
    setDismissing(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{item.title || "—"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>{item.subtitle}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>Since {nowStr(item.since)}</div>
        </div>
        {item.bidCount != null && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>{item.bidCount}</div>
            <div style={{ fontSize: 10.5, color: C.gray }}>{item.bidCount === 1 ? "bid" : "bids"}</div>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>
        {item.jobId && (
          <a href={`/jobs/${item.jobId}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11.5, color: C.teal, textDecoration: "underline" }}>
            View job →
          </a>
        )}
        {!readOnly && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Btn size="sm" full={false} variant="ghost" disabled={dismissing} onClick={() => dismiss("reviewed")}>
              Mark reviewed
            </Btn>
            <Btn size="sm" full={false} variant="teal" disabled={dismissing} onClick={() => dismiss("resolved")}>
              Mark resolved
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

export function CustomerStallsTab({ stalls, onChanged, setToast, readOnly }) {
  const [filter, setFilter] = useState("all");
  const visible = filter === "all" ? stalls.items : stalls.items.filter(i => i.category === filter);

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} style={{
            background: filter === f.id ? C.pine : C.paper, color: filter === f.id ? C.paper : C.ink,
            border: `1px solid ${filter === f.id ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
            fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>
            {f.label} ({f.id === "all" ? stalls.items.length : (stalls.counts[f.id] || 0)})
          </button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {visible.length === 0 && <div style={{ fontSize: 13, color: C.gray, textAlign: "center", padding: 24 }}>Nothing here right now.</div>}
        {visible.map(item => (
          <Row key={`${item.category}:${item.refId}`} item={item} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />
        ))}
      </div>
    </div>
  );
}
