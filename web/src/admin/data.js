import { supabase } from "../lib/supabaseClient";

export async function loadUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

// Admin bypasses RLS via is_admin() in the profiles_update_own policy, so this can update
// any user's row. Only the fields listed here are ever sent — role and email are deliberately
// not editable from this form (role changes ripple into business logic; email is the auth
// identity and needs its own admin-API flow).
export async function updateUserProfile(userId, fields) {
  const { error } = await supabase.from("profiles").update(fields).eq("id", userId);
  if (error) throw error;
}

export async function loadJobsWithBids() {
  const { data: jobs, error } = await supabase.from("jobs").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  const jobIds = jobs.map(j => j.id);
  let bids = [];
  if (jobIds.length) {
    const { data, error: bidsError } = await supabase.from("bids").select("*").in("job_id", jobIds);
    if (bidsError) throw bidsError;
    bids = data;
  }
  const peopleIds = [...new Set([...jobs.map(j => j.customer_id), ...bids.map(b => b.hauler_id)])];
  const { data: people, error: peopleError } = peopleIds.length
    ? await supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds)
    : { data: [], error: null };
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries(people.map(p => [p.id, p.business_name || p.name]));

  const bookedJobIds = jobs.filter(j => j.status === "booked").map(j => j.id);
  const { data: chats, error: chatsError } = bookedJobIds.length
    ? await supabase.from("chats").select("id, job_id").in("job_id", bookedJobIds).is("superseded_at", null)
    : { data: [], error: null };
  if (chatsError) throw chatsError;
  const chatIdByJobId = Object.fromEntries(chats.map(c => [c.job_id, c.id]));

  return jobs.map(j => ({
    ...j,
    customerName: nameById[j.customer_id],
    chatId: chatIdByJobId[j.id],
    bids: bids.filter(b => b.job_id === j.id).map(b => ({ ...b, businessName: nameById[b.hauler_id] })),
  }));
}

export async function loadFlaggedMessages() {
  const { data: msgs, error } = await supabase.from("messages").select("*").not("flag_type", "is", null).order("created_at", { ascending: false });
  if (error) throw error;
  if (msgs.length === 0) return [];

  const chatIds = [...new Set(msgs.map(m => m.chat_id))];
  const { data: chats, error: chatsError } = await supabase.from("chats").select("id, job_id, customer_id, hauler_id").in("id", chatIds);
  if (chatsError) throw chatsError;
  const chatById = Object.fromEntries(chats.map(c => [c.id, c]));

  const jobIds = [...new Set(chats.map(c => c.job_id))];
  const peopleIds = [...new Set([...chats.map(c => c.customer_id), ...chats.map(c => c.hauler_id)])];
  const [{ data: jobs, error: jobsError }, { data: people, error: peopleError }] = await Promise.all([
    supabase.from("jobs").select("id, title").in("id", jobIds),
    supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds),
  ]);
  if (jobsError) throw jobsError;
  if (peopleError) throw peopleError;
  const jobTitleById = Object.fromEntries(jobs.map(j => [j.id, j.title]));
  const nameById = Object.fromEntries(people.map(p => [p.id, p.business_name || p.name]));

  return msgs.map(m => {
    const chat = chatById[m.chat_id];
    const senderId = m.sender_role === "customer" ? chat?.customer_id : chat?.hauler_id;
    return {
      ...m,
      jobTitle: chat ? jobTitleById[chat.job_id] : undefined,
      senderName: senderId ? nameById[senderId] : undefined,
    };
  });
}

export async function setFlagReviewed(messageId, reviewed) {
  const { error } = await supabase.from("messages").update({ flag_reviewed: reviewed }).eq("id", messageId);
  if (error) throw error;
}

export async function setOverdueReviewed(jobId, reviewed) {
  const { error } = await supabase.from("jobs").update({ overdue_reviewed: reviewed }).eq("id", jobId);
  if (error) throw error;
}

export async function loadOverdueJobs() {
  const nowIso = new Date().toISOString();
  const { data: jobs, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("status", "booked")
    .eq("completed", false)
    .lt("complete_by", nowIso);
  if (error) throw error;
  if (jobs.length === 0) return [];

  const bidIds = jobs.map(j => j.accepted_bid_id).filter(Boolean);
  const { data: bids, error: bidsError } = bidIds.length
    ? await supabase.from("bids").select("*").in("id", bidIds)
    : { data: [], error: null };
  if (bidsError) throw bidsError;
  const bidById = Object.fromEntries(bids.map(b => [b.id, b]));

  const peopleIds = [...new Set([...jobs.map(j => j.customer_id), ...bids.map(b => b.hauler_id)])];
  const { data: people, error: peopleError } = peopleIds.length
    ? await supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds)
    : { data: [], error: null };
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries(people.map(p => [p.id, p.business_name || p.name]));

  return jobs.map(j => {
    const bid = j.accepted_bid_id ? bidById[j.accepted_bid_id] : null;
    return {
      ...j,
      customerName: nameById[j.customer_id],
      bid: bid ? { ...bid, businessName: nameById[bid.hauler_id] } : null,
    };
  });
}

export async function loadHaulerDocuments() {
  const { data: docs, error } = await supabase.from("hauler_documents").select("*").order("uploaded_at", { ascending: false });
  if (error) throw error;
  if (docs.length === 0) return [];

  const haulerIds = [...new Set(docs.map(d => d.hauler_id))];
  const { data: people, error: peopleError } = await supabase.from("public_profiles").select("id, name, business_name").in("id", haulerIds);
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries(people.map(p => [p.id, p.business_name || p.name]));

  return Promise.all(docs.map(async d => {
    const { data: signed } = await supabase.storage.from("hauler-documents").createSignedUrl(d.storage_path, 3600);
    return { ...d, haulerName: nameById[d.hauler_id], url: signed?.signedUrl };
  }));
}

export async function reviewHaulerDocument(documentId, approved, note) {
  const { error } = await supabase.rpc("review_hauler_document", { p_document_id: documentId, p_approved: approved, p_note: note || null });
  if (error) throw error;
}

export async function loadAdminInvites() {
  const { data: invites, error } = await supabase.from("admin_invites").select("*").is("accepted_at", null).order("created_at", { ascending: false });
  if (error) throw error;
  if (invites.length === 0) return [];

  const inviterIds = [...new Set(invites.map(i => i.invited_by))];
  const { data: people, error: peopleError } = await supabase.from("public_profiles").select("id, name").in("id", inviterIds);
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries(people.map(p => [p.id, p.name]));

  return invites.map(i => ({ ...i, invitedByName: nameById[i.invited_by] }));
}

export async function createAdminInvite(email, adminReadOnly) {
  const { error } = await supabase.rpc("create_admin_invite", { p_email: email, p_admin_read_only: adminReadOnly });
  if (error) throw error;
}

export async function cancelAdminInvite(inviteId) {
  const { error } = await supabase.rpc("cancel_admin_invite", { p_invite_id: inviteId });
  if (error) throw error;
}

export async function loadAutoExportEnabled() {
  const { data, error } = await supabase.from("app_config").select("value").eq("key", "auto_export_enabled").single();
  if (error) throw error;
  return data.value === "true";
}

export async function setAutoExportEnabled(enabled) {
  const { error } = await supabase.rpc("set_auto_export_enabled", { p_enabled: enabled });
  if (error) throw error;
}

export async function sendMonthlyExportNow() {
  const { error } = await supabase.rpc("send_monthly_export_now");
  if (error) throw error;
}

// Admin completion queue: every job the hauler has marked done, newest first. Admin RLS
// (is_admin()) grants full read of chats/jobs/profiles, so these are plain joins.
export async function loadCompletedJobs() {
  const { data: chats, error } = await supabase
    .from("chats")
    .select("*")
    .not("hauler_done_at", "is", null)
    .order("hauler_done_at", { ascending: false });
  if (error) throw error;
  if (chats.length === 0) return [];

  const jobIds = chats.map(c => c.job_id);
  const partyIds = [...new Set(chats.flatMap(c => [c.customer_id, c.hauler_id]))];
  const [{ data: jobs }, { data: profiles }] = await Promise.all([
    supabase.from("jobs").select("id, title, zip").in("id", jobIds),
    supabase.from("profiles").select("id, name, business_name").in("id", partyIds),
  ]);
  const jobById = Object.fromEntries((jobs || []).map(j => [j.id, j]));
  const pById = Object.fromEntries((profiles || []).map(p => [p.id, p]));

  return chats.map(c => ({
    ...c,
    jobTitle: jobById[c.job_id]?.title,
    zip: jobById[c.job_id]?.zip,
    customerName: pById[c.customer_id]?.name || "Customer",
    haulerName: pById[c.hauler_id]?.business_name || pById[c.hauler_id]?.name || "Hauler",
  }));
}

export async function reviewCompletion(jobId) {
  const { error } = await supabase.rpc("admin_review_completion", { p_job_id: jobId });
  if (error) throw error;
}

export async function loadDefaultPaymentMode() {
  const { data, error } = await supabase.from("app_config").select("value").eq("key", "default_payment_mode").single();
  if (error) throw error;
  return data.value;
}

export async function setDefaultPaymentMode(mode) {
  const { error } = await supabase.rpc("set_default_payment_mode", { p_mode: mode });
  if (error) throw error;
}

export async function loadCancellationRequests() {
  const { data: requests, error } = await supabase.from("cancellation_requests").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  if (requests.length === 0) return [];

  const jobIds = [...new Set(requests.map(r => r.job_id))];
  const chatIds = [...new Set(requests.map(r => r.chat_id))];
  const [{ data: jobs, error: jobsError }, { data: chats, error: chatsError }] = await Promise.all([
    supabase.from("jobs").select("id, title, zip").in("id", jobIds),
    supabase.from("chats").select("id, customer_id, hauler_id, bid_amount").in("id", chatIds),
  ]);
  if (jobsError) throw jobsError;
  if (chatsError) throw chatsError;
  const jobById = Object.fromEntries((jobs || []).map(j => [j.id, j]));
  const chatById = Object.fromEntries((chats || []).map(c => [c.id, c]));

  const peopleIds = [...new Set([...(chats || []).flatMap(c => [c.customer_id, c.hauler_id]), ...requests.map(r => r.requested_by)])];
  const { data: people, error: peopleError } = await supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds);
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.business_name || p.name]));

  // job_refundable_charges is only meaningful (and only needed, to default the admin's refund
  // input) while a request is still pending — a resolved one already has its own refund/retained
  // amounts recorded.
  return Promise.all(requests.map(async r => {
    const chat = chatById[r.chat_id];
    let heldAmount = null;
    if (r.status === "pending") {
      const { data: charges, error: chargesError } = await supabase.rpc("job_refundable_charges", { p_job_id: r.job_id });
      if (!chargesError) heldAmount = (charges || []).reduce((sum, c) => sum + Number(c.refundable), 0);
    }
    return {
      ...r,
      jobTitle: jobById[r.job_id]?.title,
      zip: jobById[r.job_id]?.zip,
      customerName: chat ? nameById[chat.customer_id] : undefined,
      haulerName: chat ? nameById[chat.hauler_id] : undefined,
      requestedByName: nameById[r.requested_by],
      bidAmount: chat?.bid_amount,
      heldAmount,
    };
  }));
}

export async function processCancellationRefund({ requestId, jobId, refundAmount }) {
  const { data, error } = await supabase.functions.invoke("process-cancellation-refund", { body: { requestId, jobId, refundAmount } });
  if (error) {
    const message = error.context?.body ? (await error.context.json?.().catch(() => null))?.message : null;
    throw new Error(message || error.message || "Could not process refund.");
  }
  return data;
}

// Full-payment accounting, additive to RevenueTab's existing deposit-mode GMV columns:
// - fundsHeld: booked full-mode jobs whose commission hasn't been earned (or the job cancelled) yet.
// - releasedToHaulers / platformEarned: split of every chat whose commission_status flipped to
//   'earned' via customer_acknowledge_completion — a bookkeeping event, not an actual Stripe
//   transfer (haulers aren't Connect accounts; this is what the admin pays out against off-platform).
// - totalRefunded: every succeeded payments row of kind='refund', switch-bid deltas and
//   cancellations alike.
export async function loadFullPaymentSummary() {
  const [{ data: chats, error: chatsError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from("chats").select("bid_amount, commission, commission_status, jobs!inner(status)").eq("payment_mode", "full").is("superseded_at", null),
    supabase.from("payments").select("amount, kind").eq("status", "succeeded"),
  ]);
  if (chatsError) throw chatsError;
  if (paymentsError) throw paymentsError;

  const fundsHeld = (chats || [])
    .filter(c => c.commission_status === "held" && c.jobs?.status === "booked")
    .reduce((sum, c) => sum + Number(c.bid_amount), 0);
  const releasedToHaulers = (chats || [])
    .filter(c => c.commission_status === "earned")
    .reduce((sum, c) => sum + (Number(c.bid_amount) - Number(c.commission)), 0);
  const platformEarned = (chats || [])
    .filter(c => c.commission_status === "earned")
    .reduce((sum, c) => sum + Number(c.commission), 0);
  const totalRefunded = (payments || [])
    .filter(p => p.kind === "refund")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  return { fundsHeld, releasedToHaulers, platformEarned, totalRefunded };
}
