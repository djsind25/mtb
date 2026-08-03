import { useCallback, useEffect, useMemo, useState } from "react";
import { sans, C, shortDateLabel } from "../theme";
import { Btn, CenteredNote } from "../ui/Primitives";
import { PostJobForm } from "../jobs/PostJobForm";
import { CustomerJobCard } from "../jobs/CustomerJobCard";
import { loadCustomerJobs, postJob, renewJob, updateJobTimeline, customerAcknowledgeCompletion } from "../jobs/data";
import { loadMyChats } from "../chat/data";
import { SummaryStrip } from "./SummaryStrip";
import { MessagesTab } from "./MessagesTab";
import { AccountTab } from "./AccountTab";
import { TotalSpentTab } from "./TotalSpentTab";
import { loadCustomerStats, resendVerificationEmail } from "./data";

const TABS = [
  { id: "jobs", label: "My Jobs" },
  { id: "messages", label: "Messages" },
  { id: "account", label: "Account" },
];

const JOB_FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "bidsWaiting", label: "Bids waiting" },
  { id: "inProgress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

const SORT_OPTIONS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
];

// Mirrors loadCustomerStats' own bucketing exactly, so a stat card's count always matches the
// jobs shown after clicking into its filter.
function matchesJobFilter(job, filter) {
  if (filter === "all") return true;
  if (filter === "active") return job.status === "open" || job.status === "pending_verification";
  if (filter === "bidsWaiting") return job.status === "open" && (job.bids || []).some(b => new Date(b.expires_at) > new Date());
  if (filter === "inProgress") return job.status === "booked" && !job.completed;
  if (filter === "completed") return job.status === "booked" && job.completed;
  if (filter === "cancelled") return job.status === "cancelled";
  return true;
}

function jobStatusLabel(job) {
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "pending_verification") return "Pending verification";
  if (job.status === "open") return "Open";
  if (job.status === "booked") return job.completed ? "Completed" : "Booked";
  return job.status;
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportJobsCsv(jobs) {
  const header = ["Title", "Status", "Posted", "Accepted Amount"];
  const lines = [header.join(",")];
  for (const j of jobs) {
    const accepted = (j.bids || []).find(b => b.id === j.accepted_bid_id);
    lines.push([j.title, jobStatusLabel(j), shortDateLabel(j.created_at), accepted ? accepted.amount : ""].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `my-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function CustomerDashboard({ session, setToast, initialChatId, onConsumedInitialChat }) {
  const [tab, setTab] = useState(initialChatId ? "messages" : "jobs");
  const [directChatId, setDirectChatId] = useState(null);
  const [customerJobs, setCustomerJobs] = useState([]);
  const [showPost, setShowPost] = useState(false);
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [jobFilter, setJobFilter] = useState("all");
  const [jobSort, setJobSort] = useState("newest");
  const [focusJobId, setFocusJobId] = useState(null);

  useEffect(() => { if (initialChatId) setTab("messages"); }, [initialChatId]);

  // Clears the highlight a couple seconds after landing on a job from Total Spent — long enough
  // to catch the eye, short enough that it doesn't look stuck if the customer lingers on the page.
  useEffect(() => {
    if (!focusJobId) return;
    const t = setTimeout(() => setFocusJobId(null), 2500);
    return () => clearTimeout(t);
  }, [focusJobId]);

  function openChat(chatId) {
    setDirectChatId(chatId);
    setTab("messages");
  }

  // Reached from Total Spent — resets the filter to "all" first so the target job is never hidden
  // behind whichever chip happened to be active.
  function openJob(jobId) {
    setJobFilter("all");
    setTab("jobs");
    setFocusJobId(jobId);
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [jobs, s, chats] = await Promise.all([
        loadCustomerJobs(session.id), loadCustomerStats(session.id), loadMyChats(session.id),
      ]);
      setCustomerJobs(jobs);
      setStats(s);
      setUnreadCount(chats.filter(c => c.unread).length);
    } catch (e) {
      setToast(e.message || "Could not load jobs.");
    }
    setLoading(false);
  }, [session.id, setToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function handlePostJob(form) {
    setPosting(true);
    try {
      await postJob({
        customerId: session.id, title: form.title, description: form.description, zip: form.zip, photos: form.photos,
        serviceType: form.serviceType, dumpsterType: form.dumpsterType, rentalStartDate: form.rentalStartDate, rentalEndDate: form.rentalEndDate,
        timeline: form.timeline,
      });
      setShowPost(false);
      const days = form.serviceType === "rental" ? 30 : 14;
      setToast(`Posted! Vetted haulers nearby will start bidding — most jobs get their first bid within 24 hours. This post stays live for ${days} days.`);
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not post job.");
    }
    setPosting(false);
  }

  async function handleRenewJob(jobId) {
    try {
      await renewJob(jobId);
      setToast("Job renewed — live for another 14 days.");
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not renew job.");
    }
  }

  function handleAccepted(chatId) {
    loadAll();
    openChat(chatId);
  }

  function handleSwitched(chatId) {
    loadAll();
    openChat(chatId);
  }

  function handleCancellationChanged() {
    loadAll();
  }

  function handleRevisionResolved() {
    loadAll();
  }

  function handleScheduleChanged() {
    loadAll();
  }

  async function handleUpdateTimeline(jobId, timeline) {
    await updateJobTimeline(jobId, timeline);
    await loadAll();
  }

  async function handleAcknowledge(jobId) {
    await customerAcknowledgeCompletion(jobId);
    await loadAll();
  }

  const visibleJobs = useMemo(() => {
    const filtered = customerJobs.filter(j => matchesJobFilter(j, jobFilter));
    // customerJobs already arrives newest-first (order by created_at desc) — "oldest" just flips it.
    return jobSort === "oldest" ? [...filtered].reverse() : filtered;
  }, [customerJobs, jobFilter, jobSort]);

  const summary = stats ? [
    { label: "Active jobs", value: stats.active, onClick: () => { setJobFilter("active"); setTab("jobs"); } },
    { label: "Bids waiting on me", value: stats.bidsWaiting, onClick: () => { setJobFilter("bidsWaiting"); setTab("jobs"); } },
    { label: "Jobs in progress", value: stats.inProgress, onClick: () => { setJobFilter("inProgress"); setTab("jobs"); } },
    { label: "Completed jobs", value: stats.completed, onClick: () => { setJobFilter("completed"); setTab("jobs"); } },
    { label: "Cancelled jobs", value: stats.cancelled, onClick: () => { setJobFilter("cancelled"); setTab("jobs"); } },
    { label: "Total spent - Year to date", value: `$${stats.totalSpent.toFixed(2)}`, onClick: () => setTab("spent") },
  ] : [];

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      {stats && <SummaryStrip stats={summary} />}

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            position: "relative", flex: 1, padding: "9px", borderRadius: 8, cursor: "pointer",
            background: tab === t.id ? C.pine : C.paper, border: `1px solid ${tab === t.id ? C.pine : C.line}`,
            fontWeight: 700, fontSize: 13, color: tab === t.id ? C.paper : C.ink, fontFamily: "inherit",
          }}>
            {t.label}
            {t.id === "messages" && (
              <span style={{
                position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9,
                background: unreadCount > 0 ? C.ember : C.grayLight, color: unreadCount > 0 ? C.paper : C.gray,
                border: `2px solid ${C.sand}`,
                fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px",
              }}>{unreadCount}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "jobs" && (
        loading ? <CenteredNote>Loading jobs…</CenteredNote> : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontFamily: sans, fontSize: 20, color: C.pineDeep, margin: 0 }}>Your jobs</h2>
              <Btn full={false} size="sm" onClick={() => setShowPost(true)}>+ Post a job</Btn>
            </div>
            {showPost && <PostJobForm onCancel={() => setShowPost(false)} onSubmit={handlePostJob} submitting={posting} />}

            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {JOB_FILTERS.map(f => (
                <button key={f.id} onClick={() => setJobFilter(f.id)} style={{
                  border: `1.5px solid ${jobFilter === f.id ? C.pine : C.line}`, borderRadius: 20,
                  background: jobFilter === f.id ? C.tealLight : C.paper, padding: "5px 12px",
                  cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: C.ink, fontFamily: "inherit",
                }}>
                  {f.label}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ fontSize: 11.5, color: C.gray, fontWeight: 600 }}>Sort:</span>
                {SORT_OPTIONS.map(s => (
                  <button key={s.id} onClick={() => setJobSort(s.id)} style={{
                    border: "none", background: "none", padding: 0, cursor: "pointer", fontFamily: "inherit",
                    fontSize: 11.5, fontWeight: jobSort === s.id ? 700 : 500, color: jobSort === s.id ? C.teal : C.gray,
                    textDecoration: jobSort === s.id ? "underline" : "none",
                  }}>
                    {s.label}
                  </button>
                ))}
              </div>
              <Btn size="sm" full={false} variant="ghost" disabled={visibleJobs.length === 0} onClick={() => exportJobsCsv(visibleJobs)}>
                ⬇ Export
              </Btn>
            </div>

            {customerJobs.length === 0 && !showPost && <CenteredNote>No jobs yet — post one to get started.</CenteredNote>}
            {customerJobs.length > 0 && visibleJobs.length === 0 && <CenteredNote>No jobs match this filter.</CenteredNote>}
            <div style={{ display: "grid", gap: 12 }}>
              {visibleJobs.map(job => (
                <CustomerJobCard key={job.id} job={job} session={session} onAccepted={handleAccepted} onSwitched={handleSwitched} onCancellationChanged={handleCancellationChanged} onOpenChat={openChat} onRenewJob={handleRenewJob} onResendVerification={resendVerificationEmail} onUpdateTimeline={handleUpdateTimeline} onAcknowledge={handleAcknowledge} onRevisionResolved={handleRevisionResolved} onScheduleChanged={handleScheduleChanged} setToast={setToast} highlighted={job.id === focusJobId} />
              ))}
            </div>
          </>
        )
      )}

      {tab === "spent" && <TotalSpentTab customerId={session.id} onOpenJob={openJob} setToast={setToast} />}

      {tab === "messages" && (
        <MessagesTab
          session={session} setToast={setToast}
          initialChatId={directChatId || initialChatId}
          onConsumedInitialChat={() => { setDirectChatId(null); onConsumedInitialChat?.(); }}
          onUnreadCountChange={setUnreadCount}
        />
      )}

      {tab === "account" && <AccountTab session={session} setToast={setToast} />}
    </div>
  );
}
