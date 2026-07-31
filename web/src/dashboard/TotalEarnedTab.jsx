import { useEffect, useMemo, useState } from "react";
import { sans, C, shortDateLabel } from "../theme";
import { Btn, CenteredNote } from "../ui/Primitives";
import { loadHaulerEarningsByJob } from "./data";

function periodsFor(year) {
  return [
    { id: "month", label: "This month" },
    { id: "ytd", label: `Year to Date ${year}` },
    { id: "all", label: "Overall" },
  ];
}

function inPeriod(iso, period) {
  if (period === "all") return true;
  const d = new Date(iso);
  const now = new Date();
  if (period === "month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (period === "ytd") return d.getFullYear() === now.getFullYear();
  return true;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, period) {
  const header = ["Job", "Price", "Net", "Date"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([csvEscape(r.jobTitle), r.gross.toFixed(2), r.net.toFixed(2), shortDateLabel(r.earnedAt)].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `earnings-${period}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function TotalEarnedTab({ haulerId, onOpenJob, setToast }) {
  const [rows, setRows] = useState(null);
  const [period, setPeriod] = useState("month");
  const PERIODS = periodsFor(new Date().getFullYear());

  useEffect(() => {
    loadHaulerEarningsByJob(haulerId).then(setRows).catch(e => {
      setToast?.(e.message || "Could not load earnings.");
      setRows([]);
    });
  }, [haulerId, setToast]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter(r => inPeriod(r.earnedAt, period)).sort((a, b) => new Date(b.earnedAt) - new Date(a.earnedAt));
  }, [rows, period]);

  const totals = filtered.reduce((acc, r) => ({ gross: acc.gross + r.gross, net: acc.net + r.net }), { gross: 0, net: 0 });

  if (rows === null) return <CenteredNote>Loading earnings…</CenteredNote>;

  return (
    <>
      <h2 style={{ fontFamily: sans, fontSize: 20, color: C.pineDeep, marginBottom: 14 }}>Earnings History</h2>

      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {PERIODS.map(p => (
          <button key={p.id} onClick={() => setPeriod(p.id)} style={{
            border: `1.5px solid ${period === p.id ? C.pine : C.line}`, borderRadius: 20,
            background: period === p.id ? C.tealLight : C.paper, padding: "5px 12px",
            cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: C.ink, fontFamily: "inherit",
          }}>
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 11, color: C.gray, marginBottom: 2 }}>Net Earnings ({PERIODS.find(p => p.id === period).label.toLowerCase()})</div>
          <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontSize: 22, fontWeight: 700, color: C.pineDeep }}>${totals.net.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: C.gray }}>${totals.gross.toFixed(2)} gross · {filtered.length} job{filtered.length === 1 ? "" : "s"}</div>
        </div>
        <Btn size="sm" full={false} variant="ghost" disabled={filtered.length === 0} onClick={() => downloadCsv(filtered, period)}>
          ⬇ Export to Excel
        </Btn>
      </div>

      {filtered.length === 0 && <CenteredNote>No completed jobs in this period.</CenteredNote>}

      <div style={{ display: "grid", gap: 8 }}>
        {filtered.map(r => (
          <button key={r.jobId} onClick={() => onOpenJob(r.jobId)} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left",
            background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px",
            cursor: "pointer", fontFamily: "inherit",
          }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>{r.jobTitle}</div>
              <div style={{ fontSize: 11, color: C.gray }}>{shortDateLabel(r.earnedAt)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${r.net.toFixed(2)} <span style={{ color: C.gray, fontWeight: 400, fontSize: 11 }}>net</span></div>
              <div style={{ fontSize: 11, color: C.gray }}>${r.gross.toFixed(2)} price</div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
