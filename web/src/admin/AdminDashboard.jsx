import { useCallback, useEffect, useState } from "react";
import { C, serif, mono, expiryLabel, isExpired, COMMISSION_RATE } from "../theme";
import { Badge, Avatar, CenteredNote } from "../ui/Primitives";
import { loadUsers, loadJobsWithBids, loadFlaggedMessages, loadOverdueJobs } from "./data";
import { Stat } from "./Stat";
import { Panel } from "./Panel";
import { JobRow, JobRowExpanded } from "./JobRow";
import { FlagRow } from "./FlagRow";
import { OverdueJobRow } from "./OverdueJobRow";

export function AdminDashboard() {
  const [tab, setTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [flags, setFlags] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [u, j, f, o] = await Promise.all([loadUsers(), loadJobsWithBids(), loadFlaggedMessages(), loadOverdueJobs()]);
    setUsers(u); setJobs(j); setFlags(f); setOverdue(o);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  if (loading) return <CenteredNote>Loading admin dashboard…</CenteredNote>;

  const customers = users.filter(u => u.role === "customer");
  const haulers = users.filter(u => u.role === "hauler");
  const bookedJobs = jobs.filter(j => j.status === "booked");
  const totalGMV = bookedJobs.reduce((sum, j) => {
    const bid = (j.bids || []).find(b => b.id === j.accepted_bid_id);
    return sum + (bid?.amount || 0);
  }, 0);
  const depositCollected = +(totalGMV * COMMISSION_RATE).toFixed(2);
  const haulerDirectVolume = +(totalGMV * (1 - COMMISSION_RATE)).toFixed(2);

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 16px 60px" }}>
      <h2 style={{ fontFamily: serif, fontSize: 24, color: C.pineDeep, marginBottom: 4 }}>🛡️ Admin dashboard</h2>
      <p style={{ fontSize: 13, color: C.gray, marginBottom: 16 }}>Full visibility — users, jobs, bids, deposit revenue, and flagged messages.</p>

      <div style={{
        background: C.tealLight, border: `1px solid ${C.teal}44`, borderRadius: 10,
        padding: "12px 14px", marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start",
      }}>
        <span style={{ fontSize: 18 }}>💳</span>
        <div style={{ fontSize: 12.5, color: C.pineDeep, lineHeight: 1.55 }}>
          <strong>Active payment model: Deposit-only (launch model)</strong>
          <div style={{ color: C.gray, marginTop: 3 }}>
            Customers prepay a 10% deposit (our revenue); the 90% balance is paid hauler-direct, off-platform. The
            payment_mode seam is in place so a future full-payment/escrow mode can be enabled without a rebuild.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 24 }}>
        <Stat label="Customers" value={customers.length} />
        <Stat label="Haulers" value={haulers.length} />
        <Stat label="Total jobs" value={jobs.length} />
        <Stat label="Booked jobs" value={bookedJobs.length} />
        <Stat label="GMV (booked)" value={`$${totalGMV.toFixed(2)}`} mono />
        <Stat label="Deposit revenue (10%)" value={`$${depositCollected.toFixed(2)}`} mono accent />
        <Stat label="Paid hauler-direct (90%)" value={`$${haulerDirectVolume.toFixed(2)}`} mono />
        <Stat label="Overdue completions" value={overdue.length} accent={overdue.length > 0} />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {[
          { id: "overview", label: "Overview" },
          { id: "users", label: `Users (${users.length})` },
          { id: "jobs", label: `Jobs & bids (${jobs.length})` },
          { id: "flags", label: `Flagged messages (${flags.length})` },
          { id: "overdue", label: `Overdue completions (${overdue.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? C.pine : C.paper, color: tab === t.id ? C.paper : C.ink,
            border: `1px solid ${tab === t.id ? C.pine : C.line}`, borderRadius: 8, padding: "8px 14px",
            fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div style={{ display: "grid", gap: 16 }}>
          <Panel title="Recent jobs">
            {jobs.slice(0, 5).map(j => <JobRow key={j.id} job={j} />)}
            {jobs.length === 0 && <CenteredNote>No jobs yet.</CenteredNote>}
          </Panel>
          {overdue.length > 0 && (
            <Panel title={`⚠ Overdue completions (${overdue.length})`}>
              {overdue.map(j => <OverdueJobRow key={j.id} job={j} />)}
            </Panel>
          )}
          <Panel title="Recent flags">
            {flags.slice(0, 5).map(f => <FlagRow key={f.id} flag={f} />)}
            {flags.length === 0 && <CenteredNote>No flagged messages yet.</CenteredNote>}
          </Panel>
        </div>
      )}

      {tab === "users" && (
        <Panel title="All accounts">
          <div style={{ display: "grid", gap: 8 }}>
            {users.length === 0 && <CenteredNote>No accounts yet.</CenteredNote>}
            {users.map(u => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: `1px solid ${C.line}`, borderRadius: 10 }}>
                <Avatar emoji={u.role === "customer" ? "👤" : u.role === "hauler" ? "🚛" : "🛡️"} size={32} bg={u.role === "customer" ? C.sandWarm : C.tealLight} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{u.role === "customer" ? u.name : (u.business_name || u.name)}</div>
                  <div style={{ fontSize: 11.5, color: C.gray }}>{u.email} · ZIP {u.zip || "—"} · joined {new Date(u.created_at).toLocaleDateString()}</div>
                </div>
                <Badge color={u.role === "customer" ? C.gray : C.teal} bg={u.role === "customer" ? C.grayLight : C.tealLight}>{u.role}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {tab === "jobs" && (
        <Panel title="All jobs & bids">
          <div style={{ display: "grid", gap: 10 }}>
            {jobs.length === 0 && <CenteredNote>No jobs yet.</CenteredNote>}
            {jobs.map(j => <JobRowExpanded key={j.id} job={j} />)}
          </div>
        </Panel>
      )}

      {tab === "flags" && (
        <Panel title="Flagged messages (Trust & Safety queue)">
          <div style={{ display: "grid", gap: 8 }}>
            {flags.length === 0 && <CenteredNote>No flagged messages yet.</CenteredNote>}
            {flags.map(f => <FlagRow key={f.id} flag={f} expanded />)}
          </div>
        </Panel>
      )}

      {tab === "overdue" && (
        <Panel title="Jobs past the 30-day completion window">
          <div style={{ display: "grid", gap: 8 }}>
            {overdue.length === 0 && <CenteredNote>Nothing overdue right now.</CenteredNote>}
            {overdue.map(j => <OverdueJobRow key={j.id} job={j} expanded />)}
          </div>
        </Panel>
      )}
    </div>
  );
}
