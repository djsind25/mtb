import { useCallback, useEffect, useState } from "react";
import { serif, C, MAX_RADIUS_MI } from "../theme";
import { Btn, CenteredNote } from "../ui/Primitives";
import { PostJobForm } from "./PostJobForm";
import { CustomerJobCard } from "./CustomerJobCard";
import { HaulerJobCard } from "./HaulerJobCard";
import { HaulerBidStatusCard } from "./HaulerBidStatusCard";
import {
  loadCustomerJobs, loadOpenJobsForHauler, loadMyBidJobs,
  postJob, submitBid, renewJob, renewBid, confirmJobComplete,
} from "./data";

export function JobsPage({ session, setToast, onOpenChat }) {
  const [customerJobs, setCustomerJobs] = useState([]);
  const [openJobs, setOpenJobs] = useState([]);
  const [myBidJobs, setMyBidJobs] = useState([]);
  const [showPost, setShowPost] = useState(false);
  const [posting, setPosting] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      if (session.role === "customer") {
        setCustomerJobs(await loadCustomerJobs(session.id));
      } else if (session.role === "hauler") {
        const [open, mine] = await Promise.all([loadOpenJobsForHauler(), loadMyBidJobs(session.id)]);
        setOpenJobs(open);
        setMyBidJobs(mine);
      }
    } catch (e) {
      setToast(e.message || "Could not load jobs.");
    }
    setLoading(false);
  }, [session.id, session.role, setToast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  async function handlePostJob(form) {
    setPosting(true);
    try {
      await postJob({
        customerId: session.id, title: form.title, description: form.description, zip: form.zip, photos: form.photos,
        serviceType: form.serviceType, dumpsterType: form.dumpsterType, rentalStartDate: form.rentalStartDate, rentalEndDate: form.rentalEndDate,
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

  async function handleConfirmComplete(jobId) {
    try {
      await confirmJobComplete(jobId);
      setToast("Job marked complete! Review form unlocked for both sides.");
      await loadAll();
    } catch (e) {
      setToast(e.message || "Could not confirm completion.");
    }
  }

  function handleAccepted(chatId) {
    loadAll();
    onOpenChat(chatId);
  }

  if (loading) return <CenteredNote>Loading jobs…</CenteredNote>;

  const myBidJobIds = new Set(myBidJobs.map(j => j.id));

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      {session.role === "customer" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontFamily: serif, fontSize: 22, color: C.pineDeep, margin: 0 }}>Your jobs</h2>
            <Btn full={false} size="sm" onClick={() => setShowPost(true)}>+ Post a job</Btn>
          </div>
          {showPost && <PostJobForm onCancel={() => setShowPost(false)} onSubmit={handlePostJob} submitting={posting} />}
          {customerJobs.length === 0 && !showPost && <CenteredNote>No jobs yet — post one to get started.</CenteredNote>}
          <div style={{ display: "grid", gap: 12 }}>
            {customerJobs.map(job => (
              <CustomerJobCard key={job.id} job={job} onAccepted={handleAccepted} onOpenChat={onOpenChat} onRenewJob={handleRenewJob} setToast={setToast} />
            ))}
          </div>
        </>
      )}

      {session.role === "hauler" && (
        <>
          <h2 style={{ fontFamily: serif, fontSize: 22, color: C.pineDeep, marginBottom: 4 }}>Open jobs near you</h2>
          <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 18 }}>
            Showing jobs within {MAX_RADIUS_MI} miles of your service ZIP ({session.zip || "not set"}). Posts stay live for 14 days unless renewed.
          </p>
          <div style={{ display: "grid", gap: 12, marginBottom: 32 }}>
            {openJobs.length === 0 && <CenteredNote>No open jobs within {MAX_RADIUS_MI} miles right now. Check back soon.</CenteredNote>}
            {openJobs.map(job => (
              <HaulerJobCard key={job.id} job={job} alreadyBid={myBidJobIds.has(job.id)} onBid={handleBid} />
            ))}
          </div>

          <h2 style={{ fontFamily: serif, fontSize: 18, color: C.pineDeep, marginBottom: 12 }}>Your bids</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {myBidJobs.length === 0 && <CenteredNote>You haven't submitted any bids yet.</CenteredNote>}
            {myBidJobs.map(job => (
              <HaulerBidStatusCard key={job.id} job={job} session={session} onOpenChat={onOpenChat} onRenewBid={handleRenewBid} onConfirmComplete={handleConfirmComplete} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
