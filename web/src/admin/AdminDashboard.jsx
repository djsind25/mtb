import { useCallback, useEffect, useState } from "react";
import { C, serif, mono, expiryLabel, isExpired, COMMISSION_RATE } from "../theme";
import { CenteredNote, Field } from "../ui/Primitives";
import { loadUsers, loadJobsWithBids, loadFlaggedMessages, loadOverdueJobs, loadHaulerDocuments } from "./data";
import { loadOpenSupportChats } from "../support/data";
import { SupportChatThread } from "../support/SupportChatThread";
import { Stat } from "./Stat";
import { Panel } from "./Panel";
import { JobRow, JobRowExpanded } from "./JobRow";
import { FlagRow } from "./FlagRow";
import { OverdueJobRow } from "./OverdueJobRow";
import { EditUserModal } from "./EditUserModal";
import { UserRow } from "./UserRow";
import { SupportChatRow } from "./SupportChatRow";
import { HaulerDocRow } from "./HaulerDocRow";

export function AdminDashboard({ session, setToast }) {
  const [tab, setTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [flags, setFlags] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [supportChats, setSupportChats] = useState([]);
  const [activeSupportChatId, setActiveSupportChatId] = useState(null);
  const [haulerDocs, setHaulerDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [userSearch, setUserSearch] = useState("");
  const [hideReviewedFlags, setHideReviewedFlags] = useState(false);
  const [hideReviewedOverdue, setHideReviewedOverdue] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [u, j, f, o, sc, hd] = await Promise.all([loadUsers(), loadJobsWithBids(), loadFlaggedMessages(), loadOverdueJobs(), loadOpenSupportChats(), loadHaulerDocuments()]);
    setUsers(u); setJobs(j); setFlags(f); setOverdue(o); setSupportChats(sc); setHaulerDocs(hd);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  if (loading) return <CenteredNote>Loading admin dashboard…</CenteredNote>;

  const customers = users.filter(u => u.role === "customer");
  const haulers = users.filter(u => u.role === "hauler");

  const searchQuery = userSearch.trim().toLowerCase();
  const matchesSearch = (u) => !searchQuery || [u.name, u.business_name, u.email, u.zip]
    .some(field => (field || "").toLowerCase().includes(searchQuery));
  const filteredCustomers = customers.filter(matchesSearch);
  const filteredHaulers = haulers.filter(matchesSearch);
  const bookedJobs = jobs.filter(j => j.status === "booked");
  const totalGMV = bookedJobs.reduce((sum, j) => {
    const bid = (j.bids || []).find(b => b.id === j.accepted_bid_id);
    return sum + (bid?.amount || 0);
  }, 0);
  const depositCollected = +(totalGMV * COMMISSION_RATE).toFixed(2);
  const haulerDirectVolume = +(totalGMV * (1 - COMMISSION_RATE)).toFixed(2);

  // Unreviewed-first (stable sort keeps each group in its original, most-recent-first order),
  // with an optional toggle to hide anything already checked off.
  const sortedFlags = [...flags].sort((a, b) => (a.flag_reviewed === b.flag_reviewed ? 0 : a.flag_reviewed ? 1 : -1));
  const visibleFlags = hideReviewedFlags ? sortedFlags.filter(f => !f.flag_reviewed) : sortedFlags;
  const unreviewedFlagCount = flags.filter(f => !f.flag_reviewed).length;

  const sortedOverdue = [...overdue].sort((a, b) => (a.overdue_reviewed === b.overdue_reviewed ? 0 : a.overdue_reviewed ? 1 : -1));
  const visibleOverdue = hideReviewedOverdue ? sortedOverdue.filter(j => !j.overdue_reviewed) : sortedOverdue;
  const unreviewedOverdueCount = overdue.filter(j => !j.overdue_reviewed).length;

  const sortedHaulerDocs = [...haulerDocs].sort((a, b) => (a.status === "pending") === (b.status === "pending") ? 0 : a.status === "pending" ? -1 : 1);
  const pendingDocCount = haulerDocs.filter(d => d.status === "pending").length;

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
          { id: "customers", label: `Customers (${customers.length})` },
          { id: "haulers", label: `Haulers (${haulers.length})` },
          { id: "jobs", label: `Jobs & bids (${jobs.length})` },
          { id: "flags", label: `Flagged messages (${unreviewedFlagCount}/${flags.length})` },
          { id: "overdue", label: `Overdue completions (${unreviewedOverdueCount}/${overdue.length})` },
          { id: "docs", label: `Hauler docs (${pendingDocCount}/${haulerDocs.length})` },
          { id: "support", label: `Support (${supportChats.length})` },
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
              {sortedOverdue.map(j => <OverdueJobRow key={j.id} job={j} onChanged={loadAll} />)}
            </Panel>
          )}
          <Panel title="Recent flags">
            {sortedFlags.slice(0, 5).map(f => <FlagRow key={f.id} flag={f} onChanged={loadAll} />)}
            {flags.length === 0 && <CenteredNote>No flagged messages yet.</CenteredNote>}
          </Panel>
        </div>
      )}

      {tab === "customers" && (
        <Panel title="Customers">
          <Field value={userSearch} onChange={setUserSearch} placeholder="Search by name, email, or ZIP…" />
          <div style={{ display: "grid", gap: 8 }}>
            {customers.length === 0 && <CenteredNote>No customer accounts yet.</CenteredNote>}
            {customers.length > 0 && filteredCustomers.length === 0 && <CenteredNote>No customers match "{userSearch}".</CenteredNote>}
            {filteredCustomers.map(u => (
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} />
            ))}
          </div>
        </Panel>
      )}

      {tab === "haulers" && (
        <Panel title="Haulers">
          <Field value={userSearch} onChange={setUserSearch} placeholder="Search by name, email, or ZIP…" />
          <div style={{ display: "grid", gap: 8 }}>
            {haulers.length === 0 && <CenteredNote>No hauler accounts yet.</CenteredNote>}
            {haulers.length > 0 && filteredHaulers.length === 0 && <CenteredNote>No haulers match "{userSearch}".</CenteredNote>}
            {filteredHaulers.map(u => (
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} />
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
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.gray, marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={hideReviewedFlags} onChange={e => setHideReviewedFlags(e.target.checked)} />
            Hide reviewed ({unreviewedFlagCount} unreviewed of {flags.length})
          </label>
          <div style={{ display: "grid", gap: 8 }}>
            {flags.length === 0 && <CenteredNote>No flagged messages yet.</CenteredNote>}
            {flags.length > 0 && visibleFlags.length === 0 && <CenteredNote>All flags reviewed. 🎉</CenteredNote>}
            {visibleFlags.map(f => <FlagRow key={f.id} flag={f} expanded onChanged={loadAll} />)}
          </div>
        </Panel>
      )}

      {tab === "overdue" && (
        <Panel title="Jobs past the 30-day completion window">
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.gray, marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={hideReviewedOverdue} onChange={e => setHideReviewedOverdue(e.target.checked)} />
            Hide reviewed ({unreviewedOverdueCount} unreviewed of {overdue.length})
          </label>
          <div style={{ display: "grid", gap: 8 }}>
            {overdue.length === 0 && <CenteredNote>Nothing overdue right now.</CenteredNote>}
            {overdue.length > 0 && visibleOverdue.length === 0 && <CenteredNote>All overdue jobs reviewed. 🎉</CenteredNote>}
            {visibleOverdue.map(j => <OverdueJobRow key={j.id} job={j} expanded onChanged={loadAll} />)}
          </div>
        </Panel>
      )}

      {tab === "docs" && (
        <Panel title="Hauler license & insurance review">
          <div style={{ display: "grid", gap: 8 }}>
            {haulerDocs.length === 0 && <CenteredNote>No documents submitted yet.</CenteredNote>}
            {sortedHaulerDocs.map(d => <HaulerDocRow key={d.id} doc={d} onChanged={loadAll} setToast={setToast} />)}
          </div>
        </Panel>
      )}

      {tab === "support" && (
        activeSupportChatId ? (
          <SupportChatThread
            supportChatId={activeSupportChatId}
            viewerRole="admin"
            viewerId={session.id}
            title={(() => {
              const c = supportChats.find(sc => sc.id === activeSupportChatId);
              return c ? `${c.requesterName || c.sender_email || "Unknown"} (${c.requesterRole || "guest"})` : "Support ticket";
            })()}
            onClose={() => { setActiveSupportChatId(null); loadAll(); }}
            setToast={setToast}
          />
        ) : (
          <Panel title="Open support tickets — any admin can pick these up">
            <div style={{ display: "grid", gap: 8 }}>
              {supportChats.length === 0 && <CenteredNote>No open support tickets.</CenteredNote>}
              {supportChats.map(c => <SupportChatRow key={c.id} chat={c} onOpen={setActiveSupportChatId} />)}
            </div>
          </Panel>
        )
      )}

      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => { setEditingUser(null); loadAll(); }}
          setToast={setToast}
        />
      )}
    </div>
  );
}
