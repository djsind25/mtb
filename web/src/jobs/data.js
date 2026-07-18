import { supabase } from "../lib/supabaseClient";

// Attaches { businessName, rating, ratingCount } to each bid by looking up haulers via the
// public_profiles view (profiles itself is RLS-locked to your own row — public_profiles exposes
// just the safe subset, including the aggregate rating the reviews trigger maintains).
async function attachHaulerNames(bids) {
  const haulerIds = [...new Set(bids.map(b => b.hauler_id))];
  if (haulerIds.length === 0) return bids;
  const { data: haulers } = await supabase.from("public_profiles").select("id, business_name, rating, rating_count, verified, license_active, insurance_active").in("id", haulerIds);
  const byId = Object.fromEntries((haulers || []).map(h => [h.id, h]));
  return bids.map(b => ({
    ...b,
    businessName: byId[b.hauler_id]?.business_name,
    rating: byId[b.hauler_id]?.rating,
    ratingCount: byId[b.hauler_id]?.rating_count,
    verified: byId[b.hauler_id]?.verified,
    licenseActive: byId[b.hauler_id]?.license_active,
    insuranceActive: byId[b.hauler_id]?.insurance_active,
  }));
}

async function attachChatIds(jobs) {
  const jobIds = jobs.map(j => j.id);
  if (jobIds.length === 0) return jobs;
  const { data: chats, error } = await supabase.from("chats").select("id, job_id, hauler_done_at, customer_ack_at").in("job_id", jobIds);
  if (error) throw error;
  const byJobId = Object.fromEntries((chats || []).map(c => [c.job_id, c]));
  return jobs.map(j => ({
    ...j,
    chatId: byJobId[j.id]?.id,
    haulerDoneAt: byJobId[j.id]?.hauler_done_at,
    customerAckAt: byJobId[j.id]?.customer_ack_at,
  }));
}

export async function loadCustomerJobs(customerId) {
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
  return attachChatIds(withBids);
}

export async function loadOpenJobsForHauler() {
  const { data, error } = await supabase.rpc("list_open_jobs_for_hauler");
  if (error) throw error;
  return data;
}

export async function loadMyBidJobs(haulerId) {
  const { data: myBids, error } = await supabase.from("bids").select("*").eq("hauler_id", haulerId);
  if (error) throw error;
  if (myBids.length === 0) return [];
  const jobIds = myBids.map(b => b.job_id);
  const { data: jobs, error: jobsError } = await supabase.from("jobs").select("*").in("id", jobIds);
  if (jobsError) throw jobsError;
  const withBids = jobs.map(j => ({ ...j, myBid: myBids.find(b => b.job_id === j.id) }));
  return attachChatIds(withBids);
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

export async function loadCompletionPhotos(jobId) {
  const { data: rows, error } = await supabase.from("job_completion_photos").select("*").eq("job_id", jobId).order("created_at", { ascending: true });
  if (error) throw error;
  const withUrls = await Promise.all(rows.map(async (r) => {
    const { data } = await supabase.storage.from("completion-photos").createSignedUrl(r.storage_path, 3600);
    return { ...r, url: data?.signedUrl };
  }));
  return withUrls;
}

// Best-effort browser geolocation captured at upload time. Resolves to {lat,lng} or null (permission
// denied, no GPS, or timeout) — we never block the upload on it, per the completion-workflow plan.
function getGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
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
    lat: geo?.lat ?? null, lng: geo?.lng ?? null, uploaded_by: haulerId,
  });
  if (rowError) throw rowError;
}

export async function deleteCompletionPhoto(photoId, storagePath) {
  await supabase.storage.from("completion-photos").remove([storagePath]);
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

export async function loadCompletedJobsCount() {
  const { data, error } = await supabase.rpc("completed_jobs_count");
  if (error) throw error;
  return Number(data) || 0;
}
