import { useCallback, useEffect, useMemo, useState } from "react";
import { sans, C, jobCategoryOf, timelineSortIndex } from "../theme";
import { entitlementsFor } from "../membership";
import { CenteredNote } from "../ui/Primitives";
import { HaulerJobCard } from "../jobs/HaulerJobCard";
import { HaulerBidStatusCard } from "../jobs/HaulerBidStatusCard";
import { FindJobsFilters } from "../jobs/FindJobsFilters";
import { loadOpenJobsForHauler, loadMyBidJobs, submitBid, updateBid, renewBid, haulerMarkDone, loadChangeOrdersEnabled, saveJobSearchPrefs, dismissJob, undismissJob } from "../jobs/data";
import { loadMyChats } from "../chat/data";
import { SummaryStrip } from "./SummaryStrip";
import { MessagesTab } from "./MessagesTab";
import { AccountTab } from "./AccountTab";
import { TotalEarnedTab } from "./TotalEarnedTab";
import { loadHaulerStats } from "./data";

const BID_FILTERS = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "won", label: "Won" },
  { id: "completed", label: "Completed" },
];

const DEFAULT_JOB_PREFS = { sort: "nearest", distanceBand: null, timelines: [], jobTypes: [], density: "compact" };

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
  const [myBidJobs, setMyBidJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [changeOrdersEnabled, setChangeOrdersEnabled] = useState(false);
  const [bidFilter, setBidFilter] = useState("all");
  const [focusJobId, setFocusJobId] = useState(null);

  // Find Jobs filtering/sorting — seeded from the hauler's saved default (if any) so opening the
  // tab applies it automatically; savedViewActive drives the "showing your saved view" banner and
  // is a local flag (not re-derived from prefs) so Reset can turn it off without deleting the
  // saved default on the server.
  const hasSavedPrefs = !!session.jobSearchPrefs;
  const [sort, setSort] = useState(session.jobSearchPrefs?.sort || DEFAULT_JOB_PREFS.sort);
  const [distanceBand, setDistanceBand] = useState(session.jobSearchPrefs?.distanceBand ?? DEFAULT_JOB_PREFS.distanceBand);
  const [timelines, setTimelines] = useState(session.jobSearchPrefs?.timelines || DEFAULT_JOB_PREFS.timelines);
  const [jobTypes, setJobTypes] = useState(session.jobSearchPrefs?.jobTypes || DEFAULT_JOB_PREFS.jobTypes);
  const [density, setDensity] = useState(session.jobSearchPrefs?.density || DEFAULT_JOB_PREFS.density);
  const [showDismissed, setShowDismissed] = useState(false);
  const [savedViewActive, setSavedViewActive] = useState(hasSavedPrefs);

  useEffect(() => { if (initialChatId) setTab("messages"); }, [initialChatId]);

  // Clears the highlight a couple seconds after landing on a job from Total Earned — long enough
  // to catch the eye, short enough that it doesn't look stuck if the hauler lingers on the page.
  useEffect(() => {
    if (!focusJobId) return;
    const t = setTimeout(() => setFocusJobId(null), 2500);
    return () => clearTimeout(t);
  }, [focusJobId]);

  function openChat(chatId) {
    setDirectChatId(chatId);
    setTab("messages");
  }

  function openJobFromEarnings(jobId) {
    setTab("bids");
    setBidFilter("completed");
    setFocusJobId(jobId);
  }

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [open, mine, s, chats, coEnabled] = await Promise.all([
        loadOpenJobsForHauler(), loadMyBidJobs(session.id), loadHaulerStats(session.id), loadMyChats(session.id), loadChangeOrdersEnabled(),
      ]);
      setOpenJobs(open);
      setMyBidJobs(mine);
      setStats(s);
      setUnreadCount(chats.filter(c => c.unread).length);
      setChangeOrdersEnabled(coEnabled);
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

  async function handleUpdateBid(bidId, amount, note) {
    try {
      await updateBid({ bidId, amount, note });
      setToast("Bid updated.");
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not update your bid.");
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

  function handleCancellationChanged() {
    loadAll();
  }

  function handleRevisionProposed() {
    loadAll();
  }

  function handleScheduleChanged() {
    loadAll();
  }

  async function handleDismiss(jobId) {
    try {
      await dismissJob({ haulerId: session.id, jobId });
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not dismiss that job.");
    }
  }

  async function handleUndismiss(jobId) {
    try {
      await undismissJob({ haulerId: session.id, jobId });
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not restore that job.");
    }
  }

  async function handleSaveDefault() {
    try {
      await saveJobSearchPrefs(session.id, { sort, distanceBand, timelines, jobTypes, density });
      setSavedViewActive(true);
      setToast("Saved as your default Find Jobs view.");
    } catch (e) {
      setToast(e.message || "Could not save your default view.");
    }
  }

  function resetFiltersToRadius() {
    setSort(DEFAULT_JOB_PREFS.sort);
    setDistanceBand(DEFAULT_JOB_PREFS.distanceBand);
    setTimelines(DEFAULT_JOB_PREFS.timelines);
    setJobTypes(DEFAULT_JOB_PREFS.jobTypes);
    setSavedViewActive(false);
  }

  const maxRadiusMi = entitlementsFor(session.membershipTier).maxRadiusMi;
  const myBidByJobId = Object.fromEntries(myBidJobs.map(j => [j.id, j.myBid]));

  // Mirrors the same won/pending/completed flags HaulerBidStatusCard.jsx computes inline per
  // card, so "which bucket is this job in" agrees everywhere it's asked. "Won" is deliberately a
  // superset that includes completed jobs (matching stats.won, an all-time cumulative count) —
  // narrowing it to "won and not yet completed" would make the Jobs Won stat card link to a list
  // that goes emptier over time as jobs finish, which reads as broken rather than as intended.
  const filteredBidJobs = useMemo(() => {
    if (bidFilter === "all") return myBidJobs;
    return myBidJobs.filter(job => {
      const won = job.status === "booked" && job.accepted_bid_id === job.myBid?.id;
      const pending = !job.status || job.status === "open";
      if (bidFilter === "active") return pending;
      if (bidFilter === "won") return won;
      if (bidFilter === "completed") return job.completed;
      return true;
    });
  }, [myBidJobs, bidFilter]);

  const dismissedCount = openJobs.filter(j => j.is_dismissed).length;
  // showDismissed decides the *base* list (a view toggle, not a "filter"); distance/timeline/job
  // type narrow within it — that split is what "X filters active" counts against.
  const baseJobs = showDismissed ? openJobs : openJobs.filter(j => !j.is_dismissed);
  const filteredOpenJobs = useMemo(() => {
    let jobs = baseJobs;
    if (distanceBand) jobs = jobs.filter(j => j.distance_mi == null || j.distance_mi <= distanceBand);
    if (timelines.length > 0) jobs = jobs.filter(j => timelines.includes(j.timeline || "flexible"));
    if (jobTypes.length > 0) jobs = jobs.filter(j => jobTypes.includes(jobCategoryOf(j)));

    const sorted = [...jobs];
    if (sort === "newest") sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    else if (sort === "fewest_bids") sorted.sort((a, b) => a.bid_count - b.bid_count);
    else if (sort === "soonest_timeline") sorted.sort((a, b) => timelineSortIndex(a.timeline) - timelineSortIndex(b.timeline));
    else sorted.sort((a, b) => (a.distance_mi ?? Infinity) - (b.distance_mi ?? Infinity));
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseJobs, distanceBand, timelines, jobTypes, sort]);

  const summary = stats ? [
    { label: "Open jobs nearby", value: stats.openNearby, onClick: () => setTab("browse") },
    { label: "Active bids", value: stats.activeBids, onClick: () => { setTab("bids"); setBidFilter("active"); } },
    { label: "Jobs won", value: stats.won, onClick: () => { setTab("bids"); setBidFilter("won"); } },
    { label: "Completed", value: `${stats.completed}/${stats.won}`, onClick: () => { setTab("bids"); setBidFilter("completed"); } },
    { label: "Total earned", value: `$${stats.totalEarned.toFixed(2)}`, onClick: () => setTab("earnings") },
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
            <h2 style={{ fontFamily: sans, fontSize: 20, color: C.pineDeep, marginBottom: 4 }}>Open jobs near you</h2>
            <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 14 }}>
              Showing jobs within {maxRadiusMi} miles of your service ZIP ({session.zip || "not set"}). Posts stay live for 14 days unless renewed.
            </p>
            <FindJobsFilters
              sort={sort} onSortChange={setSort}
              distanceBand={distanceBand} onDistanceBandChange={setDistanceBand} maxRadiusMi={maxRadiusMi}
              timelines={timelines} onTimelinesChange={setTimelines}
              jobTypes={jobTypes} onJobTypesChange={setJobTypes}
              density={density} onDensityChange={setDensity}
              showDismissed={showDismissed} onShowDismissedChange={setShowDismissed} dismissedCount={dismissedCount}
              matchCount={filteredOpenJobs.length} totalCount={baseJobs.length}
              savedViewActive={savedViewActive} onSaveDefault={handleSaveDefault} onResetToRadius={resetFiltersToRadius}
            />
            <div style={{ display: "grid", gap: 12 }}>
              {openJobs.length === 0 && <CenteredNote>No open jobs within {maxRadiusMi} miles right now. Check back soon.</CenteredNote>}
              {openJobs.length > 0 && baseJobs.length === 0 && (
                <CenteredNote>All {dismissedCount} job{dismissedCount === 1 ? "" : "s"} in your radius {dismissedCount === 1 ? "is" : "are"} dismissed. Toggle "show dismissed" in Filters to see them.</CenteredNote>
              )}
              {baseJobs.length > 0 && filteredOpenJobs.length === 0 && (
                <CenteredNote>
                  No jobs match your filters — <button onClick={resetFiltersToRadius} style={{ background: "none", border: "none", color: C.teal, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0, textDecoration: "underline" }}>clear filters</button> to see all {baseJobs.length} job{baseJobs.length === 1 ? "" : "s"} in your radius.
                </CenteredNote>
              )}
              {filteredOpenJobs.map(job => (
                <HaulerJobCard key={job.id} job={job} myBid={myBidByJobId[job.id]} haulerId={session.id}
                  eligible={session.licenseActive && session.insuranceActive}
                  density={density} dismissed={job.is_dismissed} onDismiss={handleDismiss} onUndismiss={handleUndismiss}
                  onBid={handleBid} onUpdateBid={handleUpdateBid} setToast={setToast} />
              ))}
            </div>
          </>
        )
      )}

      {tab === "bids" && (
        loading ? <CenteredNote>Loading bids…</CenteredNote> : (
          <>
            <h2 style={{ fontFamily: sans, fontSize: 20, color: C.pineDeep, marginBottom: 12 }}>Your bids</h2>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
              {BID_FILTERS.map(f => (
                <button key={f.id} onClick={() => setBidFilter(f.id)} style={{
                  border: `1.5px solid ${bidFilter === f.id ? C.green : C.line}`, borderRadius: 20,
                  background: bidFilter === f.id ? C.tealLight : C.paper, padding: "5px 12px",
                  cursor: "pointer", fontSize: 11.5, fontWeight: 600, color: C.ink, fontFamily: "inherit",
                }}>
                  {f.label}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              {myBidJobs.length === 0 && <CenteredNote>You haven't submitted any bids yet.</CenteredNote>}
              {myBidJobs.length > 0 && filteredBidJobs.length === 0 && <CenteredNote>No bids in this view.</CenteredNote>}
              {filteredBidJobs.map(job => (
                <HaulerBidStatusCard key={job.id} job={job} session={session} changeOrdersEnabled={changeOrdersEnabled}
                  onOpenChat={openChat} onRenewBid={handleRenewBid} onMarkDone={handleMarkDone}
                  onCancellationChanged={handleCancellationChanged} onRevisionProposed={handleRevisionProposed}
                  onScheduleChanged={handleScheduleChanged} setToast={setToast}
                  highlighted={job.id === focusJobId} />
              ))}
            </div>
          </>
        )
      )}

      {tab === "earnings" && (
        <TotalEarnedTab haulerId={session.id} onOpenJob={openJobFromEarnings} setToast={setToast} />
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
