import { useCallback, useEffect, useState } from "react";
import { serif, C } from "../theme";
import { Btn, CenteredNote } from "../ui/Primitives";
import { PostJobForm } from "../jobs/PostJobForm";
import { CustomerJobCard } from "../jobs/CustomerJobCard";
import { loadCustomerJobs, postJob, renewJob, loadCompletedJobsCount, updateJobTimeline } from "../jobs/data";
import { loadMyChats } from "../chat/data";
import { SummaryStrip } from "./SummaryStrip";
import { MessagesTab } from "./MessagesTab";
import { AccountTab } from "./AccountTab";
import { loadCustomerStats, resendVerificationEmail } from "./data";

const TABS = [
  { id: "jobs", label: "My Jobs" },
  { id: "messages", label: "Messages" },
  { id: "account", label: "Account" },
];

export function CustomerDashboard({ session, setToast, initialChatId, onConsumedInitialChat }) {
  const [tab, setTab] = useState(initialChatId ? "messages" : "jobs");
  const [directChatId, setDirectChatId] = useState(null);
  const [customerJobs, setCustomerJobs] = useState([]);
  const [showPost, setShowPost] = useState(false);
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [completedCount, setCompletedCount] = useState(null);
  const [stats, setStats] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => { if (initialChatId) setTab("messages"); }, [initialChatId]);

  function openChat(chatId) {
    setDirectChatId(chatId);
    setTab("messages");
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [jobs, count, s, chats] = await Promise.all([
        loadCustomerJobs(session.id), loadCompletedJobsCount(), loadCustomerStats(session.id), loadMyChats(session.id),
      ]);
      setCustomerJobs(jobs);
      setCompletedCount(count);
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

  async function handleUpdateTimeline(jobId, timeline) {
    await updateJobTimeline(jobId, timeline);
    await loadAll();
  }

  const summary = stats ? [
    { label: "Active jobs", value: stats.active },
    { label: "Bids waiting on me", value: stats.bidsWaiting },
    { label: "Jobs in progress", value: stats.inProgress },
    { label: "Completed jobs", value: stats.completed },
    { label: "Total spent", value: `$${stats.totalSpent.toFixed(2)}` },
  ] : [];

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      {stats && <SummaryStrip stats={summary} />}

      <div style={{ display: "flex", gap: 6, marginBottom: 18, background: C.sandWarm, borderRadius: 10, padding: 4 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            position: "relative", flex: 1, padding: "9px", borderRadius: 7, border: "none", cursor: "pointer",
            background: tab === t.id ? C.paper : "transparent", fontWeight: 700, fontSize: 13,
            color: tab === t.id ? C.pineDeep : C.gray, fontFamily: "inherit",
          }}>
            {t.label}
            {t.id === "messages" && (
              <span style={{
                position: "absolute", top: 2, right: 2, minWidth: 16, height: 16, borderRadius: 8,
                background: unreadCount > 0 ? C.ember : C.grayLight, color: unreadCount > 0 ? C.paper : C.gray,
                fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px",
              }}>{unreadCount}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "jobs" && (
        loading ? <CenteredNote>Loading jobs…</CenteredNote> : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontFamily: serif, fontSize: 20, color: C.pineDeep, margin: 0 }}>Your jobs</h2>
              <Btn full={false} size="sm" onClick={() => setShowPost(true)}>+ Post a job</Btn>
            </div>
            {showPost && <PostJobForm onCancel={() => setShowPost(false)} onSubmit={handlePostJob} submitting={posting} />}
            {customerJobs.length === 0 && !showPost && <CenteredNote>No jobs yet — post one to get started.</CenteredNote>}
            <div style={{ display: "grid", gap: 12 }}>
              {customerJobs.map(job => (
                <CustomerJobCard key={job.id} job={job} completedCount={completedCount} onAccepted={handleAccepted} onOpenChat={openChat} onRenewJob={handleRenewJob} onResendVerification={resendVerificationEmail} onUpdateTimeline={handleUpdateTimeline} setToast={setToast} />
              ))}
            </div>
          </>
        )
      )}

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
