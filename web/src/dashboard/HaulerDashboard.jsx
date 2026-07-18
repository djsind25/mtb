import { useCallback, useEffect, useState } from "react";
import { serif, C, MAX_RADIUS_MI, TIMELINE_OPTIONS } from "../theme";
import { CenteredNote } from "../ui/Primitives";
import { HaulerJobCard } from "../jobs/HaulerJobCard";
import { HaulerBidStatusCard } from "../jobs/HaulerBidStatusCard";
import { loadOpenJobsForHauler, loadMyBidJobs, submitBid, renewBid, haulerMarkDone } from "../jobs/data";
import { loadMyChats } from "../chat/data";
import { SummaryStrip } from "./SummaryStrip";
import { MessagesTab } from "./MessagesTab";
import { AccountTab } from "./AccountTab";
import { loadHaulerStats } from "./data";

const TABS = [
  { id: "browse", label: "Browse Jobs" },
  { id: "bids", label: "My Bids" },
  { id: "messages", label: "Messages" },
  { id: "account", label: "Account" },
];

export function HaulerDashboard({ session, setToast, initialChatId, onConsumedInitialChat }) {
  const [tab, setTab] = useState(initialChatId ? "messages" : "browse");
  const [directChatId, setDirectChatId] = useState(null);
  const [openJobs, setOpenJobs] = useState([]);
  const [timelineFilter, setTimelineFilter] = useState("all");
  const [myBidJobs, setMyBidJobs] = useState([]);
  const [loading, setLoading] = useState(true);
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
      const [open, mine, s, chats] = await Promise.all([
        loadOpenJobsForHauler(), loadMyBidJobs(session.id), loadHaulerStats(session.id), loadMyChats(session.id),
      ]);
      setOpenJobs(open);
      setMyBidJobs(mine);
      setStats(s);
      setUnreadCount(chats.filter(c => c.unread).length);
    } catch (e) {
      setToast(e.message || "Could not load jobs.");
    }
    setLoading(false);
  }, [session.id, setToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleBid(jobId, amount, note) {
    try {
      await submitBid({ jobId, haulerId: session.id, amount, note });
      setToast("Bid submitted! It stays open for the customer to accept for 14 days.");
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not submit bid.");
    }
  }

  async function handleRenewBid(bidId) {
    try {
      await renewBid(bidId);
      setToast("Bid renewed — live for another 14 days.");
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not renew bid.");
    }
  }

  async function handleMarkDone(jobId) {
    await haulerMarkDone(jobId);
    setToast("Marked complete! The customer has been asked to acknowledge.");
    await loadAll();
  }

  const myBidJobIds = new Set(myBidJobs.map(j => j.id));
  // Legacy jobs with no stated timeline are grouped under "Flexible" for filtering purposes
  // (even though their card shows no badge at all — see timelineMeta in theme.js).
  const filteredOpenJobs = timelineFilter === "all" ? openJobs : openJobs.filter(j => (j.timeline || "flexible") === timelineFilter);

  const summary = stats ? [
    { label: "Open jobs nearby", value: stats.openNearby },
    { label: "Active bids", value: stats.activeBids },
    { label: "Jobs won", value: stats.won },
    { label: "Completed", value: stats.completed },
    { label: "Total earned", value: `$${stats.totalEarned.toFixed(2)}` },
  ] : [];

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      {stats && <SummaryStrip stats={summary} />}

      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            position: "relative", flex: 1, padding: "9px 6px", borderRadius: 8, cursor: "pointer",
            background: tab === t.id ? C.pine : C.paper, border: `1px solid ${tab === t.id ? C.pine : C.line}`,
            fontWeight: 700, fontSize: 12.5, color: tab === t.id ? C.paper : C.ink, fontFamily: "inherit",
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

      {tab === "browse" && (
        loading ? <CenteredNote>Loading jobs…</CenteredNote> : (
          <>
            <h2 style={{ fontFamily: serif, fontSize: 20, color: C.pineDeep, marginBottom: 4 }}>Open jobs near you</h2>
            <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 14 }}>
              Showing jobs within {MAX_RADIUS_MI} miles of your service ZIP ({session.zip || "not set"}). Posts stay live for 14 days unless renewed.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
              {[{ id: "all", label: "All timelines" }, ...TIMELINE_OPTIONS].map(o => (
                <button key={o.id} onClick={() => setTimelineFilter(o.id)} style={{
                  border: `1.5px solid ${timelineFilter === o.id ? C.green : C.line}`, borderRadius: 20,
                  background: timelineFilter === o.id ? C.tealLight : C.paper, padding: "5px 12px",
                  cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: C.ink, fontFamily: "inherit",
                }}>{o.label}</button>
              ))}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              {openJobs.length === 0 && <CenteredNote>No open jobs within {MAX_RADIUS_MI} miles right now. Check back soon.</CenteredNote>}
              {openJobs.length > 0 && filteredOpenJobs.length === 0 && <CenteredNote>No open jobs match that timeline right now.</CenteredNote>}
              {filteredOpenJobs.map(job => (
                <HaulerJobCard key={job.id} job={job} alreadyBid={myBidJobIds.has(job.id)} onBid={handleBid} />
              ))}
            </div>
          </>
        )
      )}

      {tab === "bids" && (
        loading ? <CenteredNote>Loading bids…</CenteredNote> : (
          <>
            <h2 style={{ fontFamily: serif, fontSize: 20, color: C.pineDeep, marginBottom: 16 }}>Your bids</h2>
            <div style={{ display: "grid", gap: 12 }}>
              {myBidJobs.length === 0 && <CenteredNote>You haven't submitted any bids yet.</CenteredNote>}
              {myBidJobs.map(job => (
                <HaulerBidStatusCard key={job.id} job={job} session={session} onOpenChat={openChat} onRenewBid={handleRenewBid} onMarkDone={handleMarkDone} setToast={setToast} />
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
