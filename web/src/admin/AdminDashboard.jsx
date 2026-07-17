import { useCallback, useEffect, useState } from "react";
import { C, serif } from "../theme";
import { CenteredNote, Field } from "../ui/Primitives";
import { loadUsers, loadJobsWithBids, loadFlaggedMessages, loadOverdueJobs, loadHaulerDocuments, loadAdminInvites } from "./data";
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
import { InviteAdminForm, AdminInviteRow } from "./InviteAdminForm";
import { RevenueTab, buildMonthlyRevenue } from "./RevenueTab";
import { AutoExportTab } from "./AutoExportTab";

export function AdminDashboard({ session, setToast }) {
  const [tab, setTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [flags, setFlags] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [supportChats, setSupportChats] = useState([]);
  const [activeSupportChatId, setActiveSupportChatId] = useState(null);
  const [haulerDocs, setHaulerDocs] = useState([]);
  const [adminInvites, setAdminInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [userSearch, setUserSearch] = useState("");
  const [hideReviewedFlags, setHideReviewedFlags] = useState(false);
  const [hideReviewedOverdue, setHideReviewedOverdue] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [u, j, f, o, sc, hd, ai] = await Promise.all([loadUsers(), loadJobsWithBids(), loadFlaggedMessages(), loadOverdueJobs(), loadOpenSupportChats(), loadHaulerDocuments(), loadAdminInvites()]);
    setUsers(u); setJobs(j); setFlags(f); setOverdue(o); setSupportChats(sc); setHaulerDocs(hd); setAdminInvites(ai);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  if (loading) return <CenteredNote>Loading admin dashboard…</CenteredNote>;

  const readOnly = !!session.adminReadOnly;
  const customers = users.filter(u => u.role === "customer");
  const haulers = users.filter(u => u.role === "hauler");
  const admins = users.filter(u => u.role === "admin");

  const searchQuery = userSearch.trim().toLowerCase();
  const matchesSearch = (u) => !searchQuery || [u.name, u.business_name, u.email, u.zip]
    .some(field => (field || "").toLowerCase().includes(searchQuery));
  const filteredCustomers = customers.filter(matchesSearch);
  const filteredHaulers = haulers.filter(matchesSearch);
  const bookedJobs = jobs.filter(j => j.status === "booked");
  const monthlyRevenue = buildMonthlyRevenue(jobs);
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonth = monthlyRevenue.find(r => r.key === currentMonthKey) || { gmv: 0, deposit: 0, haulerDirect: 0 };
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const recentJobCount = jobs.filter(j => new Date(j.created_at) >= sixtyDaysAgo).length;

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

      {readOnly && (
        <div style={{
          background: C.amberLight, border: `1px solid ${C.amber}66`, borderRadius: 10,
          padding: "10px 14px", marginBottom: 16, fontSize: 12.5, color: "#8A6604", fontWeight: 600,
        }}>
          👁️ View-only admin — you can see everything here, but can't make changes.
        </div>
      )}

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
        <Stat label="Total jobs — last 60 days" value={recentJobCount} onClick={() => setTab("jobs")} />
        <Stat label="Booked jobs" value={bookedJobs.length} />
        <Stat label="GMV (booked) — this month" value={`$${thisMonth.gmv.toFixed(2)}`} mono onClick={() => setTab("revenue")} />
        <Stat label="Deposit revenue (10%) — this month" value={`$${thisMonth.deposit.toFixed(2)}`} mono accent onClick={() => setTab("revenue")} />
        <Stat label="Paid hauler-direct (90%) — this month" value={`$${thisMonth.haulerDirect.toFixed(2)}`} mono onClick={() => setTab("revenue")} />
        <Stat label="Overdue completions" value={overdue.length} accent={overdue.length > 0} onClick={() => setTab("overdue")} />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {[
          { id: "overview", label: "Overview" },
          { id: "customers", label: `Customers (${customers.length})` },
          { id: "haulers", label: `Haulers (${haulers.length})` },
          { id: "admins", label: `Admins (${admins.length})` },
          { id: "jobs", label: `Jobs & bids (${jobs.length})` },
          { id: "revenue", label: "Revenue" },
          { id: "autoExport", label: "Auto export" },
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
              {sortedOverdue.map(j => <OverdueJobRow key={j.id} job={j} onChanged={loadAll} readOnly={readOnly} />)}
            </Panel>
          )}
          <Panel title="Recent flags">
            {sortedFlags.slice(0, 5).map(f => <FlagRow key={f.id} flag={f} onChanged={loadAll} readOnly={readOnly} />)}
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
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
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
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
            ))}
          </div>
        </Panel>
      )}

      {tab === "admins" && (
        <Panel title="Admin accounts">
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>
            View-only admins can see every screen but can't approve documents, deactivate accounts,
            edit profiles, or reply to support tickets.
          </p>

          {session.superAdmin && <InviteAdminForm onChanged={loadAll} setToast={setToast} />}

          {adminInvites.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Pending invites</div>
              <div style={{ display: "grid", gap: 8 }}>
                {adminInvites.map(i => (
                  <AdminInviteRow key={i.id} invite={i} onChanged={loadAll} setToast={setToast} canCancel={session.superAdmin} />
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "grid", gap: 8 }}>
            {admins.length === 0 && <CenteredNote>No admin accounts.</CenteredNote>}
            {admins.map(u => (
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
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

      {tab === "revenue" && (
        <Panel title="Revenue by month">
          <RevenueTab jobs={jobs} />
        </Panel>
      )}

      {tab === "autoExport" && (
        <Panel title="Auto export">
          <AutoExportTab session={session} setToast={setToast} />
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
            {visibleFlags.map(f => <FlagRow key={f.id} flag={f} expanded onChanged={loadAll} readOnly={readOnly} />)}
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
            {visibleOverdue.map(j => <OverdueJobRow key={j.id} job={j} expanded onChanged={loadAll} readOnly={readOnly} />)}
          </div>
        </Panel>
      )}

      {tab === "docs" && (
        <Panel title="Hauler license & insurance review">
          <div style={{ display: "grid", gap: 8 }}>
            {haulerDocs.length === 0 && <CenteredNote>No documents submitted yet.</CenteredNote>}
            {sortedHaulerDocs.map(d => <HaulerDocRow key={d.id} doc={d} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />)}
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
            readOnly={readOnly}
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
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
