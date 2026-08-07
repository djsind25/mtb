import { useCallback, useEffect, useState } from "react";
import { C, RADIUS, SHADOW_MD } from "../theme";
import { CenteredNote, Field, Btn } from "../ui/Primitives";
import { loadUsers, loadJobsWithBids, loadFlaggedMessages, loadFlaggedJobQuestions, loadFlaggedJobUpdates, loadOverdueJobs, loadHaulerDocuments, loadAdminInvites, loadCompletedJobs, loadCancellationRequests, loadFullPaymentSummary, loadProfileChangeRequests, loadChangeOrdersEnabled, setChangeOrdersEnabled, loadStalledJobs, loadChatSupportQueue, loadAccountDeletionQueue, loadAccountLifecycleAuditLog, loadCustomerStalls, loadRecruitingLeads } from "./data";
import { ProfileChangeRequestRow } from "./ProfileChangeRequestRow";
import { MEMBERSHIP_TIERS, tierName } from "../membership";
import { loadSupportChats } from "../support/data";
import { processDueAccountDeletions } from "../jobs/data";
import { SupportChatThread } from "../support/SupportChatThread";
import { Stat } from "./Stat";
import { Panel } from "./Panel";
import { JobRow, JobRowExpanded } from "./JobRow";
import { FlagRow } from "./FlagRow";
import { OverdueJobRow } from "./OverdueJobRow";
import { EditUserModal } from "./EditUserModal";
import { UserRow, userDisplayName } from "./UserRow";
import { UserReviewPanel } from "./UserReviewPanel";
import { SupportChatRow } from "./SupportChatRow";
import { HaulerDocRow } from "./HaulerDocRow";
import { InviteAdminForm, AdminInviteRow } from "./InviteAdminForm";
import { RevenueTab, buildMonthlyRevenue } from "./RevenueTab";
import { AutoExportTab } from "./AutoExportTab";
import { MoneyPolicyTab } from "./MoneyPolicyTab";
import { CompletionReview } from "./CompletionReview";
import { CancellationRequestsTab } from "./CancellationRequestsTab";
import { StalledJobsTab } from "./StalledJobsTab";
import { JobChatSupportQueueTab } from "./JobChatSupportQueueTab";
import { AccountDeletionsTab } from "./AccountDeletionsTab";
import { CustomerStallsTab } from "./CustomerStallsTab";
import { HaulerRecruitingTab } from "./HaulerRecruitingTab";

function AttentionItem({ item, onOpen }) {
  return (
    <button
      type="button"
      className={`admin-attention-item${item.priority ? ` admin-attention-item--${item.priority}` : ""}`}
      onClick={() => onOpen(item.id)}
    >
      <span className="admin-attention-item__count">{item.count}</span>
      <span style={{ minWidth: 0 }}>
        <span className="admin-attention-item__label">{item.label}</span>
        <span className="admin-attention-item__description">{item.description}</span>
      </span>
      <span className="admin-attention-item__arrow" aria-hidden="true">→</span>
    </button>
  );
}

function SnapshotRow({ label, value, onClick }) {
  return (
    <button type="button" className="admin-snapshot-row" onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
    </button>
  );
}

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
  const [completedJobs, setCompletedJobs] = useState([]);
  const [cancellationRequests, setCancellationRequests] = useState([]);
  const [stalledJobs, setStalledJobs] = useState([]);
  const [chatSupportQueue, setChatSupportQueue] = useState([]);
  const [accountDeletionQueue, setAccountDeletionQueue] = useState([]);
  const [accountLifecycleAuditLog, setAccountLifecycleAuditLog] = useState([]);
  const [customerStalls, setCustomerStalls] = useState({ items: [], counts: {} });
  const [recruitingLeads, setRecruitingLeads] = useState([]);
  const [leadsSubTab, setLeadsSubTab] = useState("stalls");
  const [profileChangeRequests, setProfileChangeRequests] = useState([]);
  const [fullPaymentSummary, setFullPaymentSummary] = useState(null);
  const [changeOrdersEnabled, setChangeOrdersEnabledState] = useState(false);
  const [togglingChangeOrders, setTogglingChangeOrders] = useState(false);
  const [bidRevisionsExpanded, setBidRevisionsExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [viewingJob, setViewingJob] = useState(null);
  const [reviewingUser, setReviewingUser] = useState(null);
  const [userSearch, setUserSearch] = useState("");
  const [userSort, setUserSort] = useState("newest");
  const [hideReviewedFlags, setHideReviewedFlags] = useState(false);
  const [hideReviewedOverdue, setHideReviewedOverdue] = useState(false);
  const [supportSubTab, setSupportSubTab] = useState("open");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      await processDueAccountDeletions();
      const [u, j, fm, fq, fu, o, sc, hd, ai, cj, cr, fps, pcr, coe, sj, csq, adq, alog, cst, rl] = await Promise.all([
        loadUsers(), loadJobsWithBids(), loadFlaggedMessages(), loadFlaggedJobQuestions(), loadFlaggedJobUpdates(), loadOverdueJobs(), loadSupportChats(), loadHaulerDocuments(),
        loadAdminInvites(), loadCompletedJobs(), loadCancellationRequests(), loadFullPaymentSummary(), loadProfileChangeRequests(), loadChangeOrdersEnabled(),
        loadStalledJobs(), loadChatSupportQueue(true), loadAccountDeletionQueue(), loadAccountLifecycleAuditLog(),
        loadCustomerStalls(), loadRecruitingLeads(),
      ]);
      // One merged, chronologically-sorted Trust & Safety queue — chat flags plus flagged Q&A
      // and job updates, each tagged so FlagRow knows which "view more" action applies.
      const f = [...fm.map(x => ({ ...x, kind: "chat" })), ...fq, ...fu].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      setUsers(u); setJobs(j); setFlags(f); setOverdue(o); setSupportChats(sc); setHaulerDocs(hd); setAdminInvites(ai); setCompletedJobs(cj);
      setCancellationRequests(cr); setFullPaymentSummary(fps); setProfileChangeRequests(pcr); setChangeOrdersEnabledState(coe); setStalledJobs(sj); setChatSupportQueue(csq);
      setAccountDeletionQueue(adq); setAccountLifecycleAuditLog(alog); setCustomerStalls(cst); setRecruitingLeads(rl);
    } catch (e) {
      console.error("AdminDashboard: loadAll failed:", e);
      setToast?.(e.message || "Could not load the admin dashboard. Try refreshing.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function toggleChangeOrders() {
    const next = !changeOrdersEnabled;
    setTogglingChangeOrders(true);
    try {
      await setChangeOrdersEnabled(next);
      setChangeOrdersEnabledState(next);
      setToast(next ? "Bid revisions (change orders) are now live." : "Bid revisions (change orders) are off again.");
    } catch (e) {
      setToast(e.message || "Could not change this setting.");
    }
    setTogglingChangeOrders(false);
  }

  if (loading) return <CenteredNote>Loading admin dashboard…</CenteredNote>;

  const readOnly = !!session.adminReadOnly;
  const customers = users.filter(u => u.role === "customer");
  const haulers = users.filter(u => u.role === "hauler");
  const admins = users.filter(u => u.role === "admin");

  const searchQuery = userSearch.trim().toLowerCase();
  const matchesSearch = (u) => !searchQuery || [u.name, u.business_name, u.email, u.zip]
    .some(field => (field || "").toLowerCase().includes(searchQuery));
  const sortUsers = (list) => [...list].sort((a, b) => {
    if (userSort === "name") return userDisplayName(a).localeCompare(userDisplayName(b));
    const delta = new Date(b.created_at) - new Date(a.created_at);
    return userSort === "oldest" ? -delta : delta;
  });
  const filteredCustomers = sortUsers(customers.filter(matchesSearch));
  const filteredHaulers = sortUsers(haulers.filter(matchesSearch));
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

  const openSupportChats = supportChats.filter(c => c.status === "open");
  const closedSupportChats = supportChats.filter(c => c.status === "closed");
  const visibleSupportChats = supportSubTab === "open" ? openSupportChats : supportSubTab === "closed" ? closedSupportChats : supportChats;

  const completionsNeedingReview = completedJobs.filter(c => !c.admin_reviewed_at).length;
  const pendingCancellationCount = cancellationRequests.filter(r => r.status === "pending").length;
  const pendingProfileChangeCount = profileChangeRequests.filter(r => r.status === "pending").length;
  const tierCounts = Object.fromEntries(Object.keys(MEMBERSHIP_TIERS).map(t => [t, haulers.filter(h => (h.membership_tier || "free") === t).length]));
  const openChatSupportCount = chatSupportQueue.filter(c => c.support_status !== "resolved").length;

  function goToTab(nextTab) {
    setTab(nextTab);
    if (nextTab === "support") setSupportSubTab("open");
  }

  const navigationGroups = [
    { id: "overview", label: "Overview", tabs: [{ id: "overview", label: "Overview" }] },
    {
      id: "work", label: "Work", tabs: [
        { id: "jobs", label: "Jobs & bids", count: jobs.length },
        { id: "completed", label: "Completion review", count: completionsNeedingReview },
        { id: "overdue", label: "Overdue", count: unreviewedOverdueCount },
        { id: "cancellations", label: "Cancellations", count: pendingCancellationCount },
        { id: "stalled", label: "Stalled jobs", count: stalledJobs.length },
        { id: "docs", label: "Hauler docs", count: pendingDocCount },
      ],
    },
    {
      id: "people", label: "People & growth", tabs: [
        { id: "customers", label: "Customers", count: customers.length },
        { id: "haulers", label: "Haulers", count: haulers.length },
        { id: "admins", label: "Admins", count: admins.length },
        { id: "leads", label: "Leads", count: customerStalls.items.length + recruitingLeads.length },
        { id: "profileChanges", label: "Profile changes", count: pendingProfileChangeCount },
        { id: "accountDeletions", label: "Account deletions", count: accountDeletionQueue.length },
      ],
    },
    {
      id: "money", label: "Money & settings", tabs: [
        { id: "revenue", label: "Revenue" },
        { id: "autoExport", label: "Auto export" },
        { id: "platformFees", label: "Money policy" },
      ],
    },
    {
      id: "support", label: "Safety & support", tabs: [
        { id: "flags", label: "Flagged messages", count: unreviewedFlagCount },
        { id: "chatSupport", label: "Job chat support", count: openChatSupportCount },
        { id: "support", label: "Chat tickets", count: openSupportChats.length },
      ],
    },
  ];
  const activeNavigationGroup = navigationGroups.find(group => group.tabs.some(item => item.id === tab)) || navigationGroups[0];

  const attentionItems = [
    { id: "flags", label: "Flagged messages", description: "Trust & Safety items waiting for review", count: unreviewedFlagCount, priority: "urgent" },
    { id: "overdue", label: "Overdue completions", description: "Jobs past the completion window", count: unreviewedOverdueCount, priority: "urgent" },
    { id: "cancellations", label: "Cancellation requests", description: "Pending customer or hauler requests", count: pendingCancellationCount, priority: "warning" },
    { id: "stalled", label: "Stalled jobs", description: "Service dates still need coordination", count: stalledJobs.length, priority: "warning" },
    { id: "docs", label: "Hauler documents", description: "License or insurance submissions to check", count: pendingDocCount },
    { id: "completed", label: "Completion reviews", description: "Completed jobs awaiting admin review", count: completionsNeedingReview },
    { id: "chatSupport", label: "Job chat support", description: "Active job conversations asking for help", count: openChatSupportCount },
    { id: "support", label: "Open chat tickets", description: "General support conversations to pick up", count: openSupportChats.length },
    { id: "profileChanges", label: "Profile changes", description: "Vetting details awaiting approval", count: pendingProfileChangeCount },
    { id: "accountDeletions", label: "Account deletions", description: "Accounts in the deletion workflow", count: accountDeletionQueue.length },
  ].filter(item => item.count > 0);
  const attentionTotal = attentionItems.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className="admin-dashboard">
      <header className="admin-page-header">
        <div>
          <h1 className="admin-page-title">
            <span className="admin-page-title__mark" aria-hidden="true">
              <svg width="17" height="19" viewBox="0 0 17 19" fill="none">
                <path d="M8.5 1.25 15 3.7v5.18c0 4.12-2.74 7.28-6.5 8.87C4.74 16.16 2 13 2 8.88V3.7l6.5-2.45Z" fill="currentColor" />
                <path d="m5.6 9.35 1.8 1.8 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Admin dashboard
          </h1>
          <p className="admin-page-subtitle">Monitor platform health and clear the work that needs attention.</p>
        </div>
        {readOnly && <div className="admin-access-note">View-only access</div>}
      </header>

      <nav className="admin-navigation" aria-label="Admin dashboard sections">
        <div className="admin-primary-nav">
          {navigationGroups.map(group => (
            <button
              type="button"
              key={group.id}
              className={`admin-primary-nav__item${activeNavigationGroup.id === group.id ? " is-active" : ""}`}
              onClick={() => goToTab(group.tabs[0].id)}
            >
              {group.label}
            </button>
          ))}
        </div>
        {activeNavigationGroup.id !== "overview" && (
          <div className="admin-secondary-nav">
            {activeNavigationGroup.tabs.map(item => (
              <button
                type="button"
                key={item.id}
                className={`admin-secondary-nav__item${tab === item.id ? " is-active" : ""}`}
                onClick={() => goToTab(item.id)}
              >
                {item.label}
                {item.count !== undefined && <span className="admin-nav-count">{item.count}</span>}
              </button>
            ))}
          </div>
        )}
      </nav>

      {tab === "overview" && (
        <div className="admin-kpi-grid">
          <Stat
            label="GMV this month"
            value={`$${thisMonth.gmv.toFixed(2)}`}
            hint={`$${thisMonth.haulerDirect.toFixed(2)} paid directly to haulers`}
            mono
            onClick={() => goToTab("revenue")}
          />
          <Stat
            label="Platform revenue"
            value={`$${thisMonth.deposit.toFixed(2)}`}
            hint="10% deposits collected this month"
            mono
            accent
            onClick={() => goToTab("revenue")}
          />
          <Stat
            label="Booked jobs"
            value={bookedJobs.length}
            hint={`${recentJobCount} jobs created in the last 60 days`}
            onClick={() => goToTab("jobs")}
          />
          <Stat
            label="Funds held"
            value={`$${(fullPaymentSummary?.fundsHeld ?? 0).toFixed(2)}`}
            hint="Full-payment jobs awaiting release"
            mono
            onClick={() => goToTab("revenue")}
          />
        </div>
      )}

      {tab === "overview" && (
        <div className="admin-overview">
          <Panel
            title="Needs attention"
            subtitle="Only queues with open items are shown."
            action={attentionItems.length > 0 ? <span className="admin-open-total">{attentionTotal} open</span> : null}
          >
            {attentionItems.length > 0 ? (
              <div className="admin-attention-grid">
                {attentionItems.map(item => <AttentionItem key={item.id} item={item} onOpen={goToTab} />)}
              </div>
            ) : (
              <div className="admin-all-clear">
                <span className="admin-all-clear__mark" aria-hidden="true">✓</span>
                <span><strong style={{ color: C.pineDeep }}>You're all caught up.</strong> There are no open admin queues right now.</span>
              </div>
            )}
          </Panel>

          <div className="admin-overview-columns">
            <Panel
              title="Recent jobs"
              subtitle="The five most recently created jobs."
              action={<button type="button" className="admin-text-link" onClick={() => goToTab("jobs")}>View all →</button>}
            >
              {jobs.slice(0, 5).map(j => <JobRow key={j.id} job={j} onClick={() => setViewingJob(j)} />)}
              {jobs.length === 0 && <CenteredNote>No jobs yet.</CenteredNote>}
            </Panel>

            <Panel title="Platform snapshot" subtitle="Accounts and activity at a glance.">
              <div className="admin-snapshot-list">
                <SnapshotRow label="Customers" value={customers.length} onClick={() => goToTab("customers")} />
                <SnapshotRow label="Haulers" value={haulers.length} onClick={() => goToTab("haulers")} />
                <SnapshotRow label="Jobs (last 60 days)" value={recentJobCount} onClick={() => goToTab("jobs")} />
                <SnapshotRow label="Active leads" value={customerStalls.items.length + recruitingLeads.length} onClick={() => goToTab("leads")} />
              </div>
              <div className="admin-tier-summary">
                <div className="admin-tier-summary__label">Hauler plans</div>
                <div className="admin-tier-summary__values">
                  {Object.keys(MEMBERSHIP_TIERS).map(t => `${tierName(t)} ${tierCounts[t]}`).join("  ·  ")}
                </div>
              </div>
            </Panel>
          </div>
        </div>
      )}

      {tab === "customers" && (
        <Panel title="Customers">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <div style={{ flex: 1 }}><Field value={userSearch} onChange={setUserSearch} placeholder="Search by name, email, or ZIP…" /></div>
            <select value={userSort} onChange={e => setUserSort(e.target.value)} style={{
              border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 10px", fontSize: 12.5,
              fontFamily: "inherit", color: C.ink, background: C.paper,
            }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {customers.length === 0 && <CenteredNote>No customer accounts yet.</CenteredNote>}
            {customers.length > 0 && filteredCustomers.length === 0 && <CenteredNote>No customers match "{userSearch}".</CenteredNote>}
            {filteredCustomers.map(u => (
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} readOnly={readOnly} session={session} />
            ))}
          </div>
        </Panel>
      )}

      {tab === "haulers" && (
        <Panel title="Haulers">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <div style={{ flex: 1 }}><Field value={userSearch} onChange={setUserSearch} placeholder="Search by name, email, or ZIP…" /></div>
            <select value={userSort} onChange={e => setUserSort(e.target.value)} style={{
              border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 10px", fontSize: 12.5,
              fontFamily: "inherit", color: C.ink, background: C.paper,
            }}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {haulers.length === 0 && <CenteredNote>No hauler accounts yet.</CenteredNote>}
            {haulers.length > 0 && filteredHaulers.length === 0 && <CenteredNote>No haulers match "{userSearch}".</CenteredNote>}
            {filteredHaulers.map(u => (
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} readOnly={readOnly} session={session} />
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
              <UserRow key={u.id} user={u} onEdit={setEditingUser} onChanged={loadAll} setToast={setToast} readOnly={readOnly} session={session} />
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
          <RevenueTab jobs={jobs} fullPaymentSummary={fullPaymentSummary} />
        </Panel>
      )}

      {tab === "autoExport" && (
        <Panel title="Auto export">
          <AutoExportTab session={session} setToast={setToast} />
        </Panel>
      )}

      {tab === "platformFees" && (
        <Panel title="Money Policy">
          <MoneyPolicyTab session={session} readOnly={readOnly} setToast={setToast} />
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

      {tab === "completed" && (
        <Panel title="Completed jobs — before/after photos & confirmations">
          <CompletionReview completedJobs={completedJobs} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
        </Panel>
      )}

      {tab === "cancellations" && (
        <Panel title="Cancellation requests">
          <CancellationRequestsTab requests={cancellationRequests} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
        </Panel>
      )}

      {tab === "stalled" && (
        <Panel title="Stalled jobs — no service date locked within ~96 hours">
          <StalledJobsTab chats={stalledJobs} />
        </Panel>
      )}

      {tab === "leads" && (
        <Panel title={leadsSubTab === "stalls" ? "Customer stalls — derived from real job/bid data" : "Hauler recruiting — manual pipeline"}>
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>
            No automated messaging or AI here — this only surfaces and tracks. Any outreach is a
            human decision.
          </p>
          <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
            {[
              { id: "stalls", label: `Customer stalls (${customerStalls.items.length})` },
              { id: "recruiting", label: `Hauler recruiting (${recruitingLeads.length})` },
            ].map(st => (
              <button key={st.id} onClick={() => setLeadsSubTab(st.id)} style={{
                background: leadsSubTab === st.id ? C.pine : C.paper, color: leadsSubTab === st.id ? C.paper : C.ink,
                border: `1px solid ${leadsSubTab === st.id ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
                fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
              }}>{st.label}</button>
            ))}
          </div>
          {leadsSubTab === "stalls" ? (
            <CustomerStallsTab stalls={customerStalls} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
          ) : (
            <HaulerRecruitingTab leads={recruitingLeads} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
          )}
        </Panel>
      )}

      {tab === "chatSupport" && (
        <Panel title="Job chat support">
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>
            Job chats where a customer or hauler asked for help, or an admin is already
            participating — distinct from "Open chat tickets" (the general Contact Administrator
            support system).
          </p>
          <JobChatSupportQueueTab queue={chatSupportQueue} onChanged={loadAll} setToast={setToast} readOnly={readOnly} session={session} />
        </Panel>
      )}

      {tab === "accountDeletions" && (
        <Panel title="Account deletions">
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>
            Accounts in their 30-day self-service or admin-initiated deletion window. Anonymization
            runs on-access (whenever any dashboard loads) plus on demand here — there's no
            background worker in this pass.
          </p>
          <AccountDeletionsTab queue={accountDeletionQueue} auditLog={accountLifecycleAuditLog} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
        </Panel>
      )}

      {tab === "profileChanges" && (
        <Panel title="Profile change requests">
          <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>
            Business name and vetting-credential edits (license number, insurance info, business
            registration) wait here for approval before they take effect.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {profileChangeRequests.length === 0 && <CenteredNote>No profile change requests yet.</CenteredNote>}
            {profileChangeRequests.map(r => (
              <ProfileChangeRequestRow key={r.id} request={r} onChanged={loadAll} setToast={setToast} readOnly={readOnly} />
            ))}
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
          <Panel title={
            supportSubTab === "open" ? "Open chats — any admin can pick these up"
            : supportSubTab === "closed" ? "Closed chats"
            : "All chat tickets"
          }>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {[
                { id: "open", label: `Open chats (${openSupportChats.length})` },
                { id: "closed", label: `Closed chats (${closedSupportChats.length})` },
                { id: "all", label: `All chat tickets (${supportChats.length})` },
              ].map(st => (
                <button key={st.id} onClick={() => setSupportSubTab(st.id)} style={{
                  background: supportSubTab === st.id ? C.pine : C.paper, color: supportSubTab === st.id ? C.paper : C.ink,
                  border: `1px solid ${supportSubTab === st.id ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
                  fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}>{st.label}</button>
              ))}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {visibleSupportChats.length === 0 && (
                <CenteredNote>
                  {supportSubTab === "open" ? "No open support tickets." : supportSubTab === "closed" ? "No closed support tickets." : "No support tickets yet."}
                </CenteredNote>
              )}
              {visibleSupportChats.map(c => <SupportChatRow key={c.id} chat={c} onOpen={setActiveSupportChatId} />)}
            </div>
          </Panel>
        )
      )}

      {activeNavigationGroup.id === "money" && (
        <div style={{
          background: changeOrdersEnabled ? C.tealLight : C.grayLight, border: `1px solid ${changeOrdersEnabled ? C.teal + "44" : C.line}`, borderRadius: RADIUS.md,
          marginTop: 18,
        }}>
          <button
            type="button"
            onClick={() => setBidRevisionsExpanded(v => !v)}
            aria-expanded={bidRevisionsExpanded}
            style={{ width: "100%", padding: "12px 14px", display: "flex", gap: 10, alignItems: "center", cursor: "pointer", background: "transparent", border: 0, textAlign: "left" }}
          >
            <div style={{ fontSize: 12.5, color: C.pineDeep, fontWeight: 700, flex: 1 }}>
              Bid revisions (change orders): {changeOrdersEnabled ? "Live" : "Off"}
            </div>
            <span style={{ fontSize: 13, color: C.gray, transform: bidRevisionsExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
          </button>
          {bidRevisionsExpanded && (
            <div style={{ padding: "0 14px 14px 14px", fontSize: 12.5, color: C.gray, lineHeight: 1.55 }}>
              Lets a hauler propose a new price on a booked-but-not-completed job, requiring the customer's
              explicit approval before it takes effect — append-only, nothing is ever overwritten.
              {session.superAdmin && (
                <div style={{ marginTop: 10 }}>
                  <Btn size="sm" full={false} variant="ghost" disabled={togglingChangeOrders} onClick={toggleChangeOrders}>
                    {togglingChangeOrders ? "Switching…" : changeOrdersEnabled ? "Turn off" : "Turn on"}
                  </Btn>
                </div>
              )}
            </div>
          )}
        </div>
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

      {viewingJob && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div style={{ background: C.paper, borderRadius: RADIUS.lg, boxShadow: SHADOW_MD, width: "100%", maxWidth: 560, maxHeight: "88vh", overflowY: "auto", padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
              <button onClick={() => setViewingJob(null)} style={{ background: "none", border: "none", color: C.gray, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>
            <JobRowExpanded
              job={viewingJob}
              onViewCustomer={j => {
                const u = users.find(u => u.id === j.customer_id);
                if (u) { setReviewingUser(u); setViewingJob(null); }
              }}
            />
          </div>
        </div>
      )}

      {reviewingUser && (
        <UserReviewPanel
          user={reviewingUser}
          onClose={() => setReviewingUser(null)}
          onFlagsChanged={loadAll}
          setToast={setToast}
          readOnly={readOnly}
          session={session}
        />
      )}
    </div>
  );
}
