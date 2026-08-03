import { supabase } from "../lib/supabaseClient";

// Silent bids: attaches { businessName, rating, ratingCount, revealed, ... } to each bid via
// job_hauler_display(), which keeps the real business name hidden (replaced with a stable "Hauler
// N" label, scoped per job) until that bid becomes the job's accepted_bid_id — see
// 20260809000000_silent_bids.sql. Trust badges (licensed/insured/verified/rating/member-since)
// still show for anonymized bids; only the name itself is withheld. Called once per job (labels
// are scoped per job_id, not globally) rather than a single batched public_profiles query.
async function attachHaulerNames(bids) {
  if (bids.length === 0) return bids;
  const jobIds = [...new Set(bids.map(b => b.job_id))];
  const perJob = await Promise.all(jobIds.map(async jobId => {
    const { data, error } = await supabase.rpc("job_hauler_display", { p_job_id: jobId });
    if (error) throw error;
    return (data || []).map(row => ({ ...row, job_id: jobId }));
  }));
  const byKey = Object.fromEntries(perJob.flat().map(row => [`${row.job_id}:${row.hauler_id}`, row]));
  return bids.map(b => {
    const info = byKey[`${b.job_id}:${b.hauler_id}`];
    return {
      ...b,
      businessName: info?.revealed ? info.business_name : (info?.label || "Hauler"),
      revealed: !!info?.revealed,
      rating: info?.rating,
      ratingCount: info?.rating_count,
      verified: info?.verified,
      licenseActive: info?.license_active,
      insuranceActive: info?.insurance_active,
      haulerSince: info?.member_since,
      membershipTier: info?.membership_tier || "free",
    };
  });
}

// superseded_at is null resolves the *current* chat — a job can accumulate historical chats from
// past hauler switches (see 20260723000000_switch_accepted_bid.sql), but every caller here wants
// the one that's actually active. Without this filter, multiple rows could share a job_id and
// which one "wins" in byJobId would be an accident of query order.
async function attachChatIds(jobs) {
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length === 0) return jobs;
  const { data: chats, error } = await supabase.from("chats").select(`
    id, job_id, hauler_done_at, customer_ack_at,
    coordination_deadline, coordination_extended_at, stalled_at,
    locked_service_date, locked_final_price, authorize_at, authorized_at, captured_at
  `).in("job_id", jobIds).is("superseded_at", null);
  if (error) throw error;
  const byJobId = Object.fromEntries((chats || []).map(c => [c.job_id, c]));
  return jobs.map(j => ({
    ...j,
    chatId: byJobId[j.id]?.id,
    haulerDoneAt: byJobId[j.id]?.hauler_done_at,
    customerAckAt: byJobId[j.id]?.customer_ack_at,
    coordinationDeadline: byJobId[j.id]?.coordination_deadline,
    coordinationExtendedAt: byJobId[j.id]?.coordination_extended_at,
    stalledAt: byJobId[j.id]?.stalled_at,
    lockedServiceDate: byJobId[j.id]?.locked_service_date,
    lockedFinalPrice: byJobId[j.id]?.locked_final_price,
    authorizeAt: byJobId[j.id]?.authorize_at,
    authorizedAt: byJobId[j.id]?.authorized_at,
    capturedAt: byJobId[j.id]?.captured_at,
  }));
}

// A hauler's bid can lose the job two different ways: the customer picked someone else up front
// (generic "chose another hauler"), or this hauler *was* accepted and later got switched out
// (should read "customer switched to another hauler" instead). Any chat row at all for this
// hauler+job — even a superseded one — means the latter, since the current chat's hauler_id
// wouldn't be them if they no longer hold the job.
async function attachSwitchedOutFlag(jobs, haulerId) {
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length === 0) return jobs;
  const { data: chats, error } = await supabase.from("chats").select("job_id").eq("hauler_id", haulerId).in("job_id", jobIds);
  if (error) throw error;
  const everAccepted = new Set((chats || []).map(c => c.job_id));
  return jobs.map(j => ({ ...j, wasAccepted: everAccepted.has(j.id) }));
}

async function attachPendingCancellation(jobs) {
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length === 0) return jobs;
  const { data: requests, error } = await supabase.from("cancellation_requests").select("job_id").eq("status", "pending").in("job_id", jobIds);
  if (error) throw error;
  const pending = new Set((requests || []).map(r => r.job_id));
  return jobs.map(j => ({ ...j, pendingCancellation: pending.has(j.id) }));
}

// Attaches the full pending row (not just a boolean) — both HaulerBidStatusCard's "awaiting
// customer" banner and CustomerJobCard's approve/decline banner need the old/new amounts and
// reason, not just whether one exists.
async function attachPendingBidRevision(jobs) {
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length === 0) return jobs;
  const { data: revisions, error } = await supabase.from("bid_revisions").select("*").eq("status", "pending").in("job_id", jobIds);
  if (error) throw error;
  const byJobId = Object.fromEntries((revisions || []).map(r => [r.job_id, r]));
  return jobs.map(j => ({ ...j, pendingRevision: byJobId[j.id] || null }));
}

// Full detail (not just a boolean) — the propose/confirm UI needs the date/price/who-proposed to
// show the right banner to whichever party hasn't confirmed yet.
async function attachPendingSchedule(jobs) {
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length === 0) return jobs;
  const { data: proposals, error } = await supabase.from("schedule_proposals").select("*").eq("status", "pending").in("job_id", jobIds);
  if (error) throw error;
  const byJobId = Object.fromEntries((proposals || []).map(p => [p.job_id, p]));
  return jobs.map(j => ({ ...j, pendingSchedule: byJobId[j.id] || null }));
}

// Opportunistic, no-op-most-of-the-time sweep for the coordination nudge/extend/stall clock and
// the 48h-before-service authorization — see sync_full_payment_schedule() for why this runs on
// every load instead of a cron. Errors are swallowed: this is best-effort freshness, not something
// that should ever block a job list from loading.
export async function syncFullPaymentSchedule() {
  try {
    await supabase.rpc("sync_full_payment_schedule");
  } catch {
    // best-effort — a failed sync just means the next load tries again
  }
}

// Same opportunistic, no-worker idiom as syncFullPaymentSchedule() above — processes any account
// whose 30-day deletion window is already up, re-checking blockers each time. Whichever user's or
// admin's dashboard happens to load next nudges the global queue forward; there's no cron in this
// trimmed pass. See process_due_account_deletions() in
// 20260815000000_account_deletion_and_suspension.sql.
export async function processDueAccountDeletions() {
  try {
    await supabase.rpc("process_due_account_deletions");
  } catch {
    // best-effort — a failed sweep just means the next load tries again
  }
}

export async function loadCustomerJobs(customerId) {
  await syncFullPaymentSchedule();
  await processDueAccountDeletions();
  const { data: jobs, error } = await supabase.from("jobs").select("*").eq("customer_id", customerId).order("created_at", { ascending: false });
  if (error) throw error;
  const jobIds = jobs.map(j => j.id);
  let bids = [];
  if (jobIds.length) {
    const { data, error: bidsError } = await supabase.from("bids").select("*").in("job_id", jobIds);
    if (bidsError) throw bidsError;
    bids = await attachHaulerNames(data);
  }
  const withBids = jobs.map(j => ({ ...j, bids: bids.filter(b => b.job_id === j.id) }));
  return attachPendingSchedule(await attachPendingBidRevision(await attachPendingCancellation(await attachChatIds(withBids))));
}

export async function loadOpenJobsForHauler() {
  await processDueAccountDeletions();
  const { data, error } = await supabase.rpc("list_open_jobs_for_hauler");
  if (error) throw error;
  return data;
}

// Saved Find Jobs default (sort/distance band/timelines/job types/density) — a plain profile
// field, not a vetting-credential, so it's freely self-editable like bio/notification_prefs.
export async function saveJobSearchPrefs(haulerId, prefs) {
  const { error } = await supabase.from("profiles").update({ job_search_prefs: prefs }).eq("id", haulerId);
  if (error) throw error;
}

// Hides a job from this hauler's Find Jobs only — hauler_dismissed_jobs has no select/insert
// grant for anyone but its own hauler_id, so this never affects what other haulers or the
// customer see. Plain insert, not upsert — the table only grants insert/select/delete (no
// update), and dismissing an already-dismissed job has nothing to change, so a duplicate-key
// conflict is just ignored rather than treated as an error.
export async function dismissJob({ haulerId, jobId }) {
  const { error } = await supabase.from("hauler_dismissed_jobs").insert({ hauler_id: haulerId, job_id: jobId });
  if (error && error.code !== "23505") throw error;
}

export async function undismissJob({ haulerId, jobId }) {
  const { error } = await supabase.from("hauler_dismissed_jobs").delete().eq("hauler_id", haulerId).eq("job_id", jobId);
  if (error) throw error;
}

// list_my_bid_jobs_for_hauler() returns each row as a nested { job, city, state, bid_count } —
// job_count needs a security-definer RPC because bids_select RLS only lets a hauler see their own
// bid rows (sealed bidding), so a plain client-side count over `bids` would silently return 0 or 1
// instead of the real total.
export async function loadMyBidJobs(haulerId) {
  await syncFullPaymentSchedule();
  await processDueAccountDeletions();
  const { data: myBids, error } = await supabase.from("bids").select("*").eq("hauler_id", haulerId);
  if (error) throw error;
  if (myBids.length === 0) return [];
  const { data: rows, error: jobsError } = await supabase.rpc("list_my_bid_jobs_for_hauler");
  if (jobsError) throw jobsError;
  const withBids = rows.map(r => ({
    ...r.job, city: r.city, state: r.state, bid_count: r.bid_count, customerName: r.customer_name,
    myBid: myBids.find(b => b.job_id === r.job.id),
  }));
  return attachPendingSchedule(await attachPendingBidRevision(await attachPendingCancellation(await attachSwitchedOutFlag(await attachChatIds(withBids), haulerId))));
}

// Append-only: propose_schedule() never overwrites bid_amount/commission on the original chat —
// it inserts a new schedule_proposals row (superseding any prior pending one) plus a system chat
// message. confirm_schedule() is the only thing that locks it in, and only the *other* party can
// do that (enforced server-side, not just hidden client-side).
export async function proposeSchedule({ jobId, serviceDate, finalPrice }) {
  const { error } = await supabase.rpc("propose_schedule", {
    p_job_id: jobId, p_service_date: serviceDate, p_final_price: Number(finalPrice),
  });
  if (error) throw error;
}

export async function confirmSchedule({ proposalId }) {
  const { error } = await supabase.rpc("confirm_schedule", { p_proposal_id: proposalId });
  if (error) throw error;
}

// Single-job counterpart to attachPendingSchedule's batched query — used by ChatThread, which only
// ever needs the one job it's already open on rather than a whole job list.
export async function loadPendingSchedule(jobId) {
  const { data, error } = await supabase.from("schedule_proposals").select("*").eq("job_id", jobId).eq("status", "pending").maybeSingle();
  if (error) throw error;
  return data;
}

// Every proposal ever made on this chat, oldest first — propose_schedule() marks the prior
// pending row 'superseded' rather than deleting it, so this is a real, queryable negotiation
// history, not something that needs its own tracking table.
export async function loadScheduleHistory(chatId) {
  const { data, error } = await supabase.from("schedule_proposals").select("*").eq("chat_id", chatId).order("created_at");
  if (error) throw error;
  return data || [];
}

export async function loadJobPhotos(jobId) {
  const { data: rows, error } = await supabase.from("job_photos").select("*").eq("job_id", jobId);
  if (error) throw error;
  const withUrls = await Promise.all(rows.map(async (r) => {
    const { data } = await supabase.storage.from("job-photos").createSignedUrl(r.storage_path, 3600);
    return { ...r, url: data?.signedUrl };
  }));
  return withUrls;
}

// Lets the customer add more photos to the job's own album mid-conversation (e.g. the hauler
// asks to see something more closely before finalizing) — same bucket/table postJob() writes to
// at creation time, so these just become part of the same album, no separate "chat photos" set.
// job_photos_insert (RLS) only checks customer_owns_job(), no status restriction, so this works
// the same whether the job is still open or already booked. toJpegIfHeic is defined further down
// in this file but hoisted, so it's available here too.
export async function addJobPhotos({ jobId, files }) {
  const uploaded = [];
  for (const file of files || []) {
    const jpeg = await toJpegIfHeic(file);
    const path = `${jobId}/${crypto.randomUUID()}-${jpeg.name}`;
    const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, jpeg);
    if (uploadError) throw uploadError;
    const { error: rowError } = await supabase.from("job_photos").insert({ job_id: jobId, storage_path: path, original_name: jpeg.name });
    if (rowError) throw rowError;
    uploaded.push(jpeg.name);
  }
  return uploaded;
}

// Q&A reads always go through job_questions_public, never the base table — that view is what
// anonymizes hauler_id from every reader except the job's own customer and admins (the base
// table has no select grant for a good reason: a client working around a "hide the name" UI
// convention by just querying the table directly shouldn't be possible).
export async function loadJobQuestions(jobId) {
  const { data, error } = await supabase.from("job_questions_public").select("*").eq("job_id", jobId).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

// job_questions_public anonymizes hauler_id even for the asker's own rows (that's deliberate —
// it's the same view every other hauler reads), so a hauler can't tell "how many of these are
// mine" from that data. job_questions_select's RLS does let a hauler read their OWN rows off the
// base table (hauler_id = auth.uid()), so this queries that directly instead.
export async function countMyOpenQuestions({ jobId, haulerId }) {
  const { count, error } = await supabase.from("job_questions").select("id", { count: "exact", head: true })
    .eq("job_id", jobId).eq("hauler_id", haulerId).is("answer", null);
  if (error) throw error;
  return count || 0;
}

export async function askJobQuestion({ jobId, haulerId, text }) {
  const { error } = await supabase.from("job_questions").insert({ job_id: jobId, hauler_id: haulerId, question: text });
  if (error) throw error;
}

export async function answerJobQuestion({ questionId, answerText }) {
  const { error } = await supabase.from("job_questions").update({ answer: answerText, answered_at: new Date().toISOString() }).eq("id", questionId);
  if (error) throw error;
}

export async function loadJobUpdates(jobId) {
  const { data, error } = await supabase.from("job_updates_public").select("*").eq("job_id", jobId).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function postJobUpdate({ jobId, text }) {
  const { error } = await supabase.from("job_updates").insert({ job_id: jobId, text });
  if (error) throw error;
}

export async function postJob({ customerId, title, description, zip, photos, serviceType, dumpsterType, rentalStartDate, rentalEndDate, timeline }) {
  const row = { customer_id: customerId, title, description, zip, timeline };
  if (serviceType === "rental") {
    row.service_type = "rental";
    row.dumpster_type = dumpsterType;
    row.rental_start_date = rentalStartDate;
    row.rental_end_date = rentalEndDate;
  }
  const { data: job, error } = await supabase.from("jobs").insert(row).select().single();
  if (error) throw error;

  for (const file of photos || []) {
    const path = `${job.id}/${crypto.randomUUID()}-${file.name}`;
    const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, file);
    if (uploadError) throw uploadError;
    const { error: photoRowError } = await supabase.from("job_photos").insert({ job_id: job.id, storage_path: path, original_name: file.name });
    if (photoRowError) throw photoRowError;
  }
  return job;
}

export async function submitBid({ jobId, haulerId, amount, note }) {
  const { error } = await supabase.from("bids").insert({ job_id: jobId, hauler_id: haulerId, amount: Number(amount), note });
  if (error) {
    if (error.code === "42501") throw new Error("Please confirm Business License and Insurance are current.");
    throw error;
  }
}

export async function updateBid({ bidId, amount, note }) {
  const { error } = await supabase.from("bids").update({ amount: Number(amount), note }).eq("id", bidId);
  if (error) {
    if (error.code === "42501") throw new Error("This bid can no longer be edited — it may have expired or already been accepted.");
    throw error;
  }
}

// The "change orders" flag — off by default, only a super admin can flip it (see
// setChangeOrdersEnabled in admin/data.js). propose_bid_revision also checks this server-side, so
// this client read is purely to decide whether to show the "Propose new price" entry point at
// all. Goes through is_change_orders_enabled() rather than a plain app_config select — that
// table's own SELECT policy is admin-only, and a hauler dashboard load isn't an admin context.
export async function loadChangeOrdersEnabled() {
  const { data, error } = await supabase.rpc("is_change_orders_enabled");
  if (error) throw error;
  return !!data;
}

// Append-only: this never touches the original bid or chat.bid_amount — it inserts a
// bid_revisions row and a system chat message. old_amount is computed server-side (latest
// approved revision, or the original chat amount), never trusted from the client.
export async function proposeBidRevision({ jobId, newAmount, reason }) {
  const { error } = await supabase.rpc("propose_bid_revision", {
    p_job_id: jobId, p_new_amount: Number(newAmount), p_reason: reason || null,
  });
  if (error) throw error;
}

export async function resolveBidRevision({ revisionId, approved }) {
  const { error } = await supabase.rpc("resolve_bid_revision", { p_revision_id: revisionId, p_approved: approved });
  if (error) throw error;
}

export async function updateJobTimeline(jobId, timeline) {
  const { error } = await supabase.from("jobs").update({ timeline }).eq("id", jobId);
  if (error) throw error;
}

export async function renewJob(jobId) {
  const { error } = await supabase.rpc("renew_job", { p_job_id: jobId });
  if (error) throw error;
}

export async function renewBid(bidId) {
  const { error } = await supabase.rpc("renew_bid", { p_bid_id: bidId });
  if (error) throw error;
}

export async function acceptBid({ jobId, bidId }) {
  const { data, error } = await supabase.functions.invoke("create-deposit-intent", { body: { jobId, bidId } });
  if (error) {
    // supabase-js only exposes the parsed body on FunctionsHttpError via .context
    const message = error.context?.body ? (await error.context.json?.().catch(() => null))?.message : null;
    throw new Error(message || error.message || "Could not start payment.");
  }
  return data; // { clientSecret, chatId, deposit, balanceDue, commission, bidAmount }
}

export async function requestCancellation({ jobId, reason }) {
  const { error } = await supabase.rpc("request_cancellation", { p_job_id: jobId, p_reason: reason });
  if (error) throw new Error(error.message || "Could not request cancellation.");
}

export async function previewBidSwitch({ jobId, newBidId }) {
  const { data, error } = await supabase.rpc("preview_bid_switch", { p_job_id: jobId, p_new_bid_id: newBidId }).single();
  if (error) throw new Error(error.message || "Could not preview this switch.");
  return data; // { current_bid_amount, new_bid_amount, delta, current_chat_id }
}

async function invokeSwitchBid(body) {
  const { data, error } = await supabase.functions.invoke("switch-bid-payment", { body });
  if (error) {
    const message = error.context?.body ? (await error.context.json?.().catch(() => null))?.message : null;
    throw new Error(message || error.message || "Could not switch haulers.");
  }
  return data; // { finalized: true, chat_id, delta } or { finalized: false, clientSecret, delta }
}

export function startBidSwitch({ jobId, newBidId }) {
  return invokeSwitchBid({ jobId, newBidId });
}

export function confirmBidSwitch({ jobId, newBidId, paymentIntentId }) {
  return invokeSwitchBid({ jobId, newBidId, paymentIntentId });
}

export async function loadCompletionPhotos(jobId) {
  const { data: rows, error } = await supabase.from("job_completion_photos").select("*").eq("job_id", jobId).order("created_at", { ascending: true });
  if (error) throw error;
  const withUrls = await Promise.all(rows.map(async (r) => {
    const { data } = await supabase.storage.from("completion-photos").createSignedUrl(r.storage_path, 3600);
    return { ...r, url: data?.signedUrl };
  }));
  return withUrls;
}

// Browser geolocation captured at upload time — best-effort, not required. This used to reject
// (blocking the entire upload) on denial/timeout/no-GPS, which meant a hauler with Location
// Services off, a denied permission prompt, or just a weak GPS lock indoors couldn't upload ANY
// completion photo at all — worse than an unverified one, and the actual bug behind "adding
// photos doesn't work". lat/lng are already nullable and CompletionPhotos already renders a
// "no loc" badge for exactly this case, so a failure here just falls back to that instead of
// blocking the upload.
//
// The `timeout` option passed to getCurrentPosition is NOT a reliable backstop on its own — on
// iOS Safari, when system-wide Location Services is off (or Safari lacks location permission),
// WebKit can silently hang forever and never invoke either callback, ignoring `timeout` entirely.
// That left the upload permanently stuck on "Adding" with no error and no photo, which is exactly
// what this was still doing on iPhone even after the fix above. Racing our own independent
// setTimeout alongside it guarantees this always settles, regardless of what the platform's
// geolocation API actually does.
function getGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ lat: null, lng: null });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    setTimeout(() => finish({ lat: null, lng: null }), 8000);
    navigator.geolocation.getCurrentPosition(
      (pos) => finish({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => finish({ lat: null, lng: null }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
    );
  });
}

// iPhones default to HEIC, which browsers can't render — convert to JPEG before upload (same
// approach as the job-post photo flow), dynamically importing heic2any so it only loads when needed.
async function toJpegIfHeic(file) {
  if (!/^image\/hei(c|f)/.test(file.type) && !/\.hei[cf]$/i.test(file.name)) return file;
  const heic2any = (await import("heic2any")).default;
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
  const blob = Array.isArray(converted) ? converted[0] : converted;
  return new File([blob], file.name.replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
}

export async function uploadCompletionPhoto({ jobId, haulerId, phase, file }) {
  const geo = await getGeolocation();
  const jpeg = await toJpegIfHeic(file);
  const path = `${jobId}/${crypto.randomUUID()}-${jpeg.name}`;
  const { error: uploadError } = await supabase.storage.from("completion-photos").upload(path, jpeg);
  if (uploadError) throw uploadError;
  const { error: rowError } = await supabase.from("job_completion_photos").insert({
    job_id: jobId, phase, storage_path: path, original_name: jpeg.name,
    lat: geo.lat, lng: geo.lng, uploaded_by: haulerId,
  });
  if (rowError) throw rowError;
}

export async function deleteCompletionPhoto(photoId, storagePath) {
  const { error: storageError } = await supabase.storage.from("completion-photos").remove([storagePath]);
  if (storageError) throw storageError;
  const { error } = await supabase.from("job_completion_photos").delete().eq("id", photoId);
  if (error) throw error;
}

export async function haulerMarkDone(jobId) {
  const { error } = await supabase.rpc("hauler_mark_done", { p_job_id: jobId });
  if (error) throw error;
}

export async function customerAcknowledgeCompletion(jobId) {
  const { error } = await supabase.rpc("customer_acknowledge_completion", { p_job_id: jobId });
  if (error) throw error;
}

