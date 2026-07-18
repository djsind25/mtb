import { supabase } from "../lib/supabaseClient";
import { loadOpenJobsForHauler } from "../jobs/data";

export async function loadCustomerStats(customerId) {
  const [{ data: jobs, error: jobsError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from("jobs").select("id, status, completed").eq("customer_id", customerId),
    // RLS already scopes this to jobs this customer owns — no extra filter needed.
    supabase.from("payments").select("amount, kind").eq("status", "succeeded"),
  ]);
  if (jobsError) throw jobsError;
  if (paymentsError) throw paymentsError;

  const active = jobs.filter(j => j.status === "open" || j.status === "pending_verification").length;
  const inProgress = jobs.filter(j => j.status === "booked" && !j.completed).length;
  const completed = jobs.filter(j => j.status === "booked" && j.completed).length;
  // Net of refunds (e.g. a switch-hauler delta) — a refund row would otherwise add to "spent"
  // instead of subtracting from it.
  const totalSpent = payments.reduce((sum, p) => sum + (p.kind === "refund" ? -Number(p.amount) : Number(p.amount)), 0);

  const openJobIds = jobs.filter(j => j.status === "open").map(j => j.id);
  let bidsWaiting = 0;
  if (openJobIds.length) {
    const { count, error } = await supabase.from("bids").select("id", { count: "exact", head: true })
      .in("job_id", openJobIds).gt("expires_at", new Date().toISOString());
    if (error) throw error;
    bidsWaiting = count || 0;
  }

  return { active, bidsWaiting, inProgress, completed, totalSpent };
}

export async function loadHaulerStats(haulerId) {
  const [openJobs, { data: myBids, error: bidsError }, { data: chats, error: chatsError }] = await Promise.all([
    loadOpenJobsForHauler(),
    supabase.from("bids").select("job_id, expires_at").eq("hauler_id", haulerId),
    // superseded_at is null: a hauler switched out of a job keeps their (historical) chat row,
    // but it shouldn't keep contributing to "won"/"completed" once someone else is doing the job.
    supabase.from("chats").select("bid_amount, commission_status, jobs(completed)").eq("hauler_id", haulerId).is("superseded_at", null),
  ]);
  if (bidsError) throw bidsError;
  if (chatsError) throw chatsError;

  const openJobIds = new Set(openJobs.map(j => j.id));
  const now = new Date().toISOString();
  const activeBids = myBids.filter(b => openJobIds.has(b.job_id) && b.expires_at > now).length;
  const won = chats.length;
  const completed = chats.filter(c => c.jobs?.completed).length;
  const totalEarned = chats.filter(c => c.commission_status === "earned").reduce((sum, c) => sum + Number(c.bid_amount), 0);

  return { openNearby: openJobs.length, activeBids, won, completed, totalEarned };
}

export async function loadCustomerPayments(customerId) {
  const { data, error } = await supabase
    .from("payments")
    .select("id, amount, status, kind, created_at, job_id, chat_id, jobs(title), chats(hauler_id)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const haulerIds = [...new Set(data.map(p => p.chats?.hauler_id).filter(Boolean))];
  const haulerById = await loadPublicProfilesById(haulerIds);
  return data.map(p => ({
    id: p.id,
    jobTitle: p.jobs?.title,
    otherParty: haulerById[p.chats?.hauler_id]?.business_name,
    amount: p.amount,
    status: p.status,
    kind: p.kind,
    createdAt: p.created_at,
  }));
}

export async function loadHaulerEarnings(haulerId) {
  const { data, error } = await supabase
    .from("payments")
    .select("id, amount, status, kind, created_at, job_id, chat_id, jobs(title), chats(customer_id)")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const customerIds = [...new Set(data.map(p => p.chats?.customer_id).filter(Boolean))];
  const customerById = await loadPublicProfilesById(customerIds);
  return data.map(p => ({
    id: p.id,
    jobTitle: p.jobs?.title,
    otherParty: customerById[p.chats?.customer_id]?.name,
    amount: p.amount,
    status: p.status,
    kind: p.kind,
    createdAt: p.created_at,
  }));
}

async function loadPublicProfilesById(ids) {
  if (ids.length === 0) return {};
  const { data, error } = await supabase.from("public_profiles").select("id, name, business_name").in("id", ids);
  if (error) throw error;
  return Object.fromEntries(data.map(p => [p.id, p]));
}

export async function updateOwnProfile(id, fields) {
  const { error } = await supabase.from("profiles").update(fields).eq("id", id);
  if (error) throw error;
}

// smsConsent is only passed when the caller wants to change it — omitting it (undefined) leaves
// the column untouched, so this can be called for a plain email-prefs save too. Turning consent
// ON stamps sms_consent_at as the compliance record of when they last agreed; turning it OFF
// intentionally leaves that timestamp alone (it should always show the last time consent was
// actually given, not get erased by opting out).
export async function updateNotificationPrefs(id, prefs, smsConsent) {
  const fields = { notification_prefs: prefs };
  if (smsConsent !== undefined) {
    fields.sms_consent = smsConsent;
    if (smsConsent) fields.sms_consent_at = new Date().toISOString();
  }
  const { error } = await supabase.from("profiles").update(fields).eq("id", id);
  if (error) throw error;
}

export async function changeEmail(newEmail) {
  const { error } = await supabase.auth.updateUser({ email: newEmail });
  if (error) throw error;
}

export async function changePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

export async function resendVerificationEmail() {
  const { error } = await supabase.rpc("resend_verification_email");
  if (error) throw error;
}

export async function deactivateOwnAccount(id) {
  const { error } = await supabase.from("profiles").update({ active: false, deactivated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
  await supabase.auth.signOut();
}

export async function loadHaulerDocuments(haulerId) {
  const { data, error } = await supabase.from("hauler_documents").select("*").eq("hauler_id", haulerId);
  if (error) throw error;
  const byType = Object.fromEntries(data.map(d => [d.doc_type, d]));
  for (const doc of data) {
    const { data: signed } = await supabase.storage.from("hauler-documents").createSignedUrl(doc.storage_path, 3600);
    doc.url = signed?.signedUrl;
  }
  return byType;
}

// A fresh upload always replaces whatever was there before (one current document per type —
// see the hauler_documents unique(hauler_id, doc_type) constraint), which is why this needs
// the hauler's own id up front rather than a doc id.
export async function submitHaulerDocument({ haulerId, docType, file, expiresAt }) {
  const path = `${haulerId}/${crypto.randomUUID()}-${file.name}`;
  const { error: uploadError } = await supabase.storage.from("hauler-documents").upload(path, file);
  if (uploadError) throw uploadError;
  const { error } = await supabase.rpc("submit_hauler_document", {
    p_doc_type: docType, p_storage_path: path, p_original_name: file.name, p_expires_at: expiresAt,
  });
  if (error) throw error;
}
