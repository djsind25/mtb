import { C, mono, COMMISSION_RATE } from "../theme";
import { Btn, CenteredNote } from "../ui/Primitives";

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

function monthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Shared by the stat cards (current month only) and this tab (full history) so the two never
// drift out of sync — both derive from the same already-loaded `jobs` array, no extra query.
export function buildMonthlyRevenue(jobs) {
  const byMonth = new Map();
  for (const j of jobs) {
    if (j.status !== "booked") continue;
    const bid = (j.bids || []).find(b => b.id === j.accepted_bid_id);
    if (!bid) continue;
    const key = monthKey(j.accepted_at || j.created_at);
    const row = byMonth.get(key) || { key, jobCount: 0, gmv: 0 };
    row.jobCount += 1;
    row.gmv += Number(bid.amount);
    byMonth.set(key, row);
  }
  return [...byMonth.values()]
    .map(r => ({
      ...r,
      deposit: +(r.gmv * COMMISSION_RATE).toFixed(2),
      haulerDirect: +(r.gmv * (1 - COMMISSION_RATE)).toFixed(2),
    }))
    .sort((a, b) => b.key.localeCompare(a.key));
}

function downloadCsv(rows) {
  const header = ["Month", "Booked jobs", "GMV (booked)", "Deposit revenue (10%)", "Paid hauler-direct (90%)"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([MONTH_LABEL.format(new Date(`${r.key}-01T00:00:00`)), r.jobCount, r.gmv.toFixed(2), r.deposit.toFixed(2), r.haulerDirect.toFixed(2)].join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mytrashbid-revenue-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function RevenueTab({ jobs }) {
  const rows = buildMonthlyRevenue(jobs);
  const totals = rows.reduce((acc, r) => ({
    jobCount: acc.jobCount + r.jobCount, gmv: acc.gmv + r.gmv, deposit: acc.deposit + r.deposit, haulerDirect: acc.haulerDirect + r.haulerDirect,
  }), { jobCount: 0, gmv: 0, deposit: 0, haulerDirect: 0 });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <p style={{ fontSize: 12.5, color: C.gray, margin: 0 }}>Booked-job revenue by month, based on each job's accepted-bid amount.</p>
        <Btn size="sm" full={false} onClick={() => downloadCsv(rows)} disabled={rows.length === 0}>⬇ Export CSV</Btn>
      </div>

      {rows.length === 0 && <CenteredNote>No booked jobs yet.</CenteredNote>}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: `2px solid ${C.line}` }}>
                <th style={{ padding: "8px 10px", color: C.gray, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>Month</th>
                <th style={{ padding: "8px 10px", color: C.gray, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>Booked jobs</th>
                <th style={{ padding: "8px 10px", color: C.gray, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>GMV</th>
                <th style={{ padding: "8px 10px", color: C.gray, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>Deposit revenue</th>
                <th style={{ padding: "8px 10px", color: C.gray, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.03em" }}>Paid hauler-direct</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} style={{ borderBottom: `1px solid ${C.line}` }}>
                  <td style={{ padding: "9px 10px", fontWeight: 600, color: C.pineDeep }}>{MONTH_LABEL.format(new Date(`${r.key}-01T00:00:00`))}</td>
                  <td style={{ padding: "9px 10px", fontFamily: mono }}>{r.jobCount}</td>
                  <td style={{ padding: "9px 10px", fontFamily: mono }}>${r.gmv.toFixed(2)}</td>
                  <td style={{ padding: "9px 10px", fontFamily: mono, color: C.teal, fontWeight: 700 }}>${r.deposit.toFixed(2)}</td>
                  <td style={{ padding: "9px 10px", fontFamily: mono }}>${r.haulerDirect.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: `2px solid ${C.line}` }}>
                <td style={{ padding: "9px 10px", fontWeight: 800, color: C.pineDeep }}>All time</td>
                <td style={{ padding: "9px 10px", fontFamily: mono, fontWeight: 800 }}>{totals.jobCount}</td>
                <td style={{ padding: "9px 10px", fontFamily: mono, fontWeight: 800 }}>${totals.gmv.toFixed(2)}</td>
                <td style={{ padding: "9px 10px", fontFamily: mono, fontWeight: 800, color: C.teal }}>${totals.deposit.toFixed(2)}</td>
                <td style={{ padding: "9px 10px", fontFamily: mono, fontWeight: 800 }}>${totals.haulerDirect.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
