import { supabase } from "../lib/supabaseClient";
import { parseRpcError } from "../lib/rpcError";

function rpcError(error) {
  const { code, message } = parseRpcError(error);
  return Object.assign(new Error(message), { code });
}

// Attaches { active, total } flag counts to each user so the list view can show a "🚩 N flags"
// badge without a per-row query — one extra platform-wide query, aggregated client-side (same
// pattern as attachHaulerNames elsewhere), which is fine at this app's scale and avoids a new
// SQL view for a single derived count.
export async function loadUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  const { data: flags } = await supabase.from("admin_user_flags").select("user_id, resolved_at");
  const countByUser = {};
  (flags || []).forEach(f => {
    const c = countByUser[f.user_id] || (countByUser[f.user_id] = { active: 0, total: 0 });
    c.total++;
    if (!f.resolved_at) c.active++;
  });
  return data.map(u => ({ ...u, flagCounts: countByUser[u.id] || { active: 0, total: 0 } }));
}

// Admin bypasses RLS via is_admin() in the profiles_update_own policy, so this can update
// any user's row. Only the fields listed here are ever sent — role and email are deliberately
// not editable from this form (role changes ripple into business logic; email is the auth
// identity and needs its own admin-API flow).
export async function updateUserProfile(userId, fields) {
  const { error } = await supabase.from("profiles").update(fields).eq("id", userId);
  if (error) throw error;
}

// Deactivate/reactivate goes through a dedicated RPC rather than updateUserProfile's plain table
// write, so step-up MFA (require_aal2()) can be enforced server-side before the change goes
// through — see supabase/migrations/20260806000000_mfa.sql.
export async function setUserActive(userId, active) {
  const { error } = await supabase.rpc("admin_set_user_active", { p_user_id: userId, p_active: active });
  if (error) throw error;
}

// Hard-delete, deliberately scoped to accounts with zero real activity — the RPC leans on
// Postgres's own foreign-key checks (jobs/bids/chats/etc. all reference profiles with
// ON DELETE NO ACTION) rather than a hand-maintained "does this user have history" check, so it
// fails cleanly with a friendly message for any account that's actually been used. See
// supabase/migrations/20260811000000_admin_delete_user.sql.
export async function deleteUser(userId) {
  const { error } = await supabase.rpc("admin_delete_user", { p_user_id: userId });
  if (error) throw error;
}

// ─── Account deletion & suspension (20260815000000_account_deletion_and_suspension.sql) ────────

// Same structured blocker check the self-service flow uses — pass a target user id to check
// someone else's account (admin-only; IDOR-guarded server-side).
export async function loadAccountDeletionBlockers(userId) {
  const { data, error } = await supabase.rpc("check_account_deletion_blockers", { p_target_user_id: userId });
  if (error) throw rpcError(error);
  return data || [];
}

export async function adminSuspendUser(userId, reason) {
  const { error } = await supabase.rpc("admin_suspend_user", { p_user_id: userId, p_reason: reason, p_client_user_agent: navigator.userAgent });
  if (error) throw rpcError(error);
}

export async function adminRestoreUser(userId, reason) {
  const { error } = await supabase.rpc("admin_restore_user", { p_user_id: userId, p_reason: reason || null, p_client_user_agent: navigator.userAgent });
  if (error) throw rpcError(error);
}

export async function adminSetBiddingRestricted(userId, restricted, reason) {
  const { error } = await supabase.rpc("admin_set_bidding_restricted", {
    p_user_id: userId, p_restricted: restricted, p_reason: reason || null, p_client_user_agent: navigator.userAgent,
  });
  if (error) throw rpcError(error);
}

export async function adminSetPostingRestricted(userId, restricted, reason) {
  const { error } = await supabase.rpc("admin_set_posting_restricted", {
    p_user_id: userId, p_restricted: restricted, p_reason: reason || null, p_client_user_agent: navigator.userAgent,
  });
  if (error) throw rpcError(error);
}

export async function adminStartDeletion(userId, reason, override = false) {
  const { error } = await supabase.rpc("admin_start_deletion", {
    p_user_id: userId, p_reason: reason, p_override: override, p_client_user_agent: navigator.userAgent,
  });
  if (error) throw rpcError(error);
}

export async function adminCancelPendingDeletion(userId, reason) {
  const { error } = await supabase.rpc("admin_cancel_pending_deletion", {
    p_user_id: userId, p_reason: reason || null, p_client_user_agent: navigator.userAgent,
  });
  if (error) throw rpcError(error);
}

export async function adminAnonymizeNow(userId, reason, force = false) {
  const { error } = await supabase.rpc("admin_anonymize_now", {
    p_user_id: userId, p_reason: reason, p_force: force, p_client_user_agent: navigator.userAgent,
  });
  if (error) throw rpcError(error);
}

export async function adminMarkDeleted(userId, reason) {
  const { error } = await supabase.rpc("admin_mark_deleted", { p_user_id: userId, p_reason: reason || null, p_client_user_agent: navigator.userAgent });
  if (error) throw rpcError(error);
}

export async function adminPurgeRetainedFiles(userId, reason) {
  const { error } = await supabase.rpc("admin_purge_retained_files", { p_user_id: userId, p_reason: reason || null, p_client_user_agent: navigator.userAgent });
  if (error) throw rpcError(error);
}

// The only path that can change verified/license_active/insurance_active now — the plain
// EditUserModal checkbox save used to flip these directly with no reason or audit trail, bypassing
// the real hauler_documents upload/review flow entirely. See
// 20260816000000_hauler_verification_override.sql.
export async function adminSetHaulerVerificationFlag(userId, field, value, reason) {
  const { error } = await supabase.rpc("admin_set_hauler_verification_flag", {
    p_user_id: userId, p_field: field, p_value: value, p_reason: reason, p_client_user_agent: navigator.userAgent,
  });
  if (error) throw rpcError(error);
}

// Safe to call on demand — re-checks blockers for every past-due account every time; this is the
// same function the (nonexistent) background worker would call, just triggered manually for now.
export async function processDueAccountDeletions() {
  const { error } = await supabase.rpc("process_due_account_deletions");
  if (error) throw rpcError(error);
}

export async function loadAccountDeletionQueue() {
  const { data, error } = await supabase.from("profiles").select("*")
    .eq("status", "deletion_requested").order("deletion_scheduled_for", { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function loadAccountLifecycleAuditLog(userId) {
  let query = supabase.from("account_lifecycle_audit_log").select("*").order("created_at", { ascending: false });
  if (userId) query = query.eq("target_user_id", userId);
  const { data, error } = await query;
  if (error) throw error;
  const ids = [...new Set(data.flatMap(r => [r.actor_id, r.target_user_id]).filter(Boolean))];
  if (ids.length === 0) return data;
  const { data: people } = await supabase.from("profiles").select("id, name, business_name, role").in("id", ids);
  const byId = Object.fromEntries((people || []).map(p => [p.id, p.role === "hauler" ? (p.business_name || p.name) : p.name]));
  return data.map(r => ({ ...r, actorName: r.actor_id ? byId[r.actor_id] : null, targetName: byId[r.target_user_id] }));
}

// Triggers the same password-reset email a user gets from "Forgot passcode?" on the login
// screen — resetPasswordForEmail() is a public GoTrue endpoint (anti-enumeration means it
// doesn't even require the email to exist), so there's no separate admin-only RPC here; this
// just saves a customer/hauler having to self-serve when they call support for help.
export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw error;
}

// Manual, admin-initiated notes on a user (e.g. a pattern of cancelled bids, repeated
// circumvention attempts across chats) — distinct from the automatic per-message/per-job
// flag_type system, which flags individual content as it's posted. See
// supabase/migrations/20260810000000_admin_user_flags.sql.
export async function loadUserFlags(userId) {
  const { data, error } = await supabase.from("admin_user_flags").select("*").eq("user_id", userId).order("created_at", { ascending: false });
  if (error) throw error;
  const ids = [...new Set(data.flatMap(f => [f.flagged_by, f.resolved_by]).filter(Boolean))];
  if (ids.length === 0) return data;
  const { data: people } = await supabase.from("profiles").select("id, name").in("id", ids);
  const byId = Object.fromEntries((people || []).map(p => [p.id, p.name]));
  return data.map(f => ({ ...f, flaggedByName: byId[f.flagged_by], resolvedByName: f.resolved_by ? byId[f.resolved_by] : null }));
}

export async function flagUser(userId, reasonType, note) {
  const { error } = await supabase.rpc("admin_flag_user", { p_user_id: userId, p_reason_type: reasonType, p_note: note || null });
  if (error) throw error;
}

export async function resolveUserFlag(flagId) {
  const { error } = await supabase.rpc("admin_resolve_user_flag", { p_flag_id: flagId });
  if (error) throw error;
}

// How many cancellation requests this user has caused, as either party — cheap extra context
// alongside their flag history when deciding whether a "cancellation_pattern" flag is warranted.
export async function loadUserCancellationCount(userId) {
  const { count, error } = await supabase.from("cancellation_requests").select("id", { count: "exact", head: true }).eq("requested_by", userId);
  if (error) throw error;
  return count || 0;
}

// Every chat thread this user has been part of, either as customer or hauler — chats.customer_id
// and chats.hauler_id are both indexed FKs straight to profiles, so no need to go via jobs/bids.
// Includes superseded chats (from hauler-switches) deliberately, since this is a full-history
// review tool, not an access-control path.
export async function loadUserChats(userId) {
  const { data, error } = await supabase
    .from("chats")
    .select("id, job_id, customer_id, hauler_id, created_at, superseded_at")
    .or(`customer_id.eq.${userId},hauler_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (data.length === 0) return data;

  const jobIds = [...new Set(data.map(c => c.job_id))];
  const otherIds = [...new Set(data.map(c => (c.customer_id === userId ? c.hauler_id : c.customer_id)))];
  const [{ data: jobs }, { data: people }] = await Promise.all([
    supabase.from("jobs").select("id, title").in("id", jobIds),
    supabase.from("public_profiles").select("id, name, business_name").in("id", otherIds),
  ]);
  const jobById = Object.fromEntries((jobs || []).map(j => [j.id, j.title]));
  const personById = Object.fromEntries((people || []).map(p => [p.id, p.business_name || p.name]));

  return data.map(c => {
    const otherId = c.customer_id === userId ? c.hauler_id : c.customer_id;
    return { ...c, jobTitle: jobById[c.job_id], otherPartyName: personById[otherId] };
  });
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
    ? await supabase.from("chats").select(`
        id, job_id, payment_mode,
        coordination_deadline, coordination_extended_at, stalled_at,
        locked_service_date, locked_final_price, locked_proposal_id, authorized_at, captured_at
      `).in("job_id", bookedJobIds).is("superseded_at", null)
    : { data: [], error: null };
  if (chatsError) throw chatsError;
  const chatByJobId = Object.fromEntries(chats.map(c => [c.job_id, c]));

  // Who proposed vs. confirmed the locked schedule — data capture the spec asks the admin
  // drill-down to surface, straight off the append-only ledger (never off chats itself, which
  // only ever holds the current locked values).
  const proposalIds = chats.map(c => c.locked_proposal_id).filter(Boolean);
  const { data: proposals, error: proposalsError } = proposalIds.length
    ? await supabase.from("schedule_proposals").select("id, proposed_role, confirmed_by").in("id", proposalIds)
    : { data: [], error: null };
  if (proposalsError) throw proposalsError;
  const proposalById = Object.fromEntries(proposals.map(p => [p.id, p]));

  return jobs.map(j => {
    const chat = chatByJobId[j.id];
    const proposal = chat?.locked_proposal_id ? proposalById[chat.locked_proposal_id] : null;
    return {
      ...j,
      customerName: nameById[j.customer_id],
      chatId: chat?.id,
      scheduling: chat ? {
        paymentMode: chat.payment_mode,
        coordinationDeadline: chat.coordination_deadline,
        coordinationExtendedAt: chat.coordination_extended_at,
        stalledAt: chat.stalled_at,
        lockedServiceDate: chat.locked_service_date,
        lockedFinalPrice: chat.locked_final_price,
        authorizedAt: chat.authorized_at,
        capturedAt: chat.captured_at,
        proposedByRole: proposal?.proposed_role,
        confirmedByName: proposal?.confirmed_by ? nameById[proposal.confirmed_by] : null,
      } : null,
      bids: bids.filter(b => b.job_id === j.id).map(b => ({ ...b, businessName: nameById[b.hauler_id] })),
    };
  });
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

// job_questions_public already resolves real hauler_id for admins (the anonymity CASE only
// hides it from other haulers) — same join shape as loadFlaggedMessages, just against a
// different table and no chat_id to link a "view full conversation" button to.
export async function loadFlaggedJobQuestions() {
  const { data: rows, error } = await supabase.from("job_questions_public").select("*").not("flag_type", "is", null).order("created_at", { ascending: false });
  if (error) throw error;
  if (rows.length === 0) return [];

  const jobIds = [...new Set(rows.map(r => r.job_id))];
  const peopleIds = [...new Set(rows.map(r => r.hauler_id).filter(Boolean))];
  const [{ data: jobs, error: jobsError }, { data: people, error: peopleError }] = await Promise.all([
    supabase.from("jobs").select("id, title").in("id", jobIds),
    peopleIds.length ? supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobsError) throw jobsError;
  if (peopleError) throw peopleError;
  const jobTitleById = Object.fromEntries(jobs.map(j => [j.id, j.title]));
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.business_name || p.name]));

  return rows.map(r => ({
    ...r,
    kind: "question",
    jobTitle: jobTitleById[r.job_id],
    senderName: r.hauler_id ? nameById[r.hauler_id] : undefined,
  }));
}

export async function setJobQuestionFlagReviewed(questionId, reviewed) {
  const { error } = await supabase.from("job_questions").update({ flag_reviewed: reviewed }).eq("id", questionId);
  if (error) throw error;
}

// job_updates has no author identity to resolve (always the job's own customer) — just the job
// title, same as job_questions above minus the hauler-name lookup.
export async function loadFlaggedJobUpdates() {
  const { data: rows, error } = await supabase.from("job_updates_public").select("*").not("flag_type", "is", null).order("created_at", { ascending: false });
  if (error) throw error;
  if (rows.length === 0) return [];

  const jobIds = [...new Set(rows.map(r => r.job_id))];
  const { data: jobs, error: jobsError } = await supabase.from("jobs").select("id, title, customer_id").in("id", jobIds);
  if (jobsError) throw jobsError;
  const jobById = Object.fromEntries(jobs.map(j => [j.id, j]));

  const customerIds = [...new Set(jobs.map(j => j.customer_id))];
  const { data: people, error: peopleError } = customerIds.length
    ? await supabase.from("public_profiles").select("id, name").in("id", customerIds)
    : { data: [], error: null };
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.name]));

  return rows.map(r => ({
    ...r,
    kind: "update",
    jobTitle: jobById[r.job_id]?.title,
    senderName: nameById[jobById[r.job_id]?.customer_id],
  }));
}

export async function setJobUpdateFlagReviewed(updateId, reviewed) {
  const { error } = await supabase.from("job_updates").update({ flag_reviewed: reviewed }).eq("id", updateId);
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

export async function loadProfileChangeRequests() {
  const { data: reqs, error } = await supabase.from("profile_change_requests").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  if (reqs.length === 0) return [];

  const haulerIds = [...new Set(reqs.map(r => r.hauler_id))];
  const { data: people, error: peopleError } = await supabase.from("public_profiles").select("id, name, business_name").in("id", haulerIds);
  if (peopleError) throw peopleError;
  const nameById = Object.fromEntries(people.map(p => [p.id, p.business_name || p.name]));

  return reqs.map(r => ({ ...r, haulerName: nameById[r.hauler_id] }));
}

export async function approveProfileChangeRequest(requestId, note) {
  const { error } = await supabase.rpc("approve_profile_change_request", { p_request_id: requestId, p_note: note || null });
  if (error) throw error;
}

export async function denyProfileChangeRequest(requestId, note) {
  const { error } = await supabase.rpc("deny_profile_change_request", { p_request_id: requestId, p_note: note || null });
  if (error) throw error;
}

export async function loadZipHistory(profileId) {
  const { data, error } = await supabase.from("profile_zip_history").select("*").eq("profile_id", profileId).order("changed_at", { ascending: false });
  if (error) throw error;
  return data;
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

export async function loadChangeOrdersEnabled() {
  const { data, error } = await supabase.from("app_config").select("value").eq("key", "change_orders_enabled").single();
  if (error) throw error;
  return data.value === "true";
}

export async function setChangeOrdersEnabled(enabled) {
  const { error } = await supabase.rpc("set_change_orders_enabled", { p_enabled: enabled });
  if (error) throw error;
}

// Platform fees (global default + per-tier overrides) — see 20260817000000_platform_fee_config.sql.
// Read directly off the table (RLS: any admin, view-only included, can select); every mutation
// goes through an RPC that enforces super_admin/allow_admin_fee_edits gating server-side and logs
// to platform_fee_audit_log.
export async function loadPlatformFeeConfig() {
  const { data, error } = await supabase.from("platform_fee_config").select("*").eq("id", true).single();
  if (error) throw error;
  return data;
}

export async function setGlobalPlatformFeeRate(rate) {
  const { error } = await supabase.rpc("set_global_platform_fee_rate", { p_rate: rate });
  if (error) throw rpcError(error);
}

// p_rate = null clears the tier's override, falling back to the global default.
export async function setTierPlatformFeeRate(tier, rate) {
  const { error } = await supabase.rpc("set_tier_platform_fee_rate", { p_tier: tier, p_rate: rate });
  if (error) throw rpcError(error);
}

export async function setAllowAdminFeeEdits(enabled) {
  const { error } = await supabase.rpc("set_allow_admin_fee_edits", { p_enabled: enabled });
  if (error) throw rpcError(error);
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

// Jobs that passed the ~96h coordination window without a locked service date — see
// sync_full_payment_schedule() in 20260803000000_full_payment_scheduling.sql. Never
// auto-cancelled, just surfaced here (dashboard badge, same as cancellation_requests) so an admin
// can nudge/investigate manually.
export async function loadStalledJobs() {
  const { data: chats, error } = await supabase.from("chats")
    .select("id, job_id, customer_id, hauler_id, bid_amount, stalled_at")
    .not("stalled_at", "is", null)
    .is("locked_service_date", null)
    .is("superseded_at", null)
    .order("stalled_at", { ascending: false });
  if (error) throw error;
  if (chats.length === 0) return [];

  const jobIds = [...new Set(chats.map(c => c.job_id))];
  const peopleIds = [...new Set(chats.flatMap(c => [c.customer_id, c.hauler_id]))];
  const [{ data: jobs, error: jobsError }, { data: people, error: peopleError }] = await Promise.all([
    supabase.from("jobs").select("id, title, zip").in("id", jobIds),
    supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds),
  ]);
  if (jobsError) throw jobsError;
  if (peopleError) throw peopleError;
  const jobById = Object.fromEntries((jobs || []).map(j => [j.id, j]));
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.business_name || p.name]));

  return chats.map(c => ({
    ...c,
    jobTitle: jobById[c.job_id]?.title,
    zip: jobById[c.job_id]?.zip,
    customerName: nameById[c.customer_id],
    haulerName: nameById[c.hauler_id],
  }));
}

// The "Job chat support" queue: every chat with an open or active support request (plus a
// caller-controlled toggle to include resolved ones), joined against job/customer/hauler/
// assigned-admin names — same shape as loadCancellationRequests/loadStalledJobs.
export async function loadChatSupportQueue(includeResolved) {
  const statuses = includeResolved ? ["requested", "active", "resolved"] : ["requested", "active"];
  const { data: chats, error } = await supabase
    .from("chats")
    .select("id, job_id, customer_id, hauler_id, support_status, admin_locked_at, assigned_admin_id, created_at")
    .in("support_status", statuses)
    .is("superseded_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (chats.length === 0) return [];

  const jobIds = [...new Set(chats.map(c => c.job_id))];
  const chatIds = chats.map(c => c.id);
  const peopleIds = [...new Set([...chats.flatMap(c => [c.customer_id, c.hauler_id]), ...chats.map(c => c.assigned_admin_id).filter(Boolean)])];
  const [{ data: jobs, error: jobsError }, { data: people, error: peopleError }, { data: requests, error: requestsError }] = await Promise.all([
    supabase.from("jobs").select("id, title, zip").in("id", jobIds),
    supabase.from("public_profiles").select("id, name, business_name").in("id", peopleIds),
    supabase.from("support_requests").select("*").in("chat_id", chatIds).order("created_at", { ascending: false }),
  ]);
  if (jobsError) throw jobsError;
  if (peopleError) throw peopleError;
  if (requestsError) throw requestsError;
  const jobById = Object.fromEntries((jobs || []).map(j => [j.id, j]));
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.business_name || p.name]));
  // Newest-first, so the first row seen per chat_id is that chat's most recent request.
  const latestRequestByChatId = {};
  for (const r of requests || []) {
    if (!latestRequestByChatId[r.chat_id]) latestRequestByChatId[r.chat_id] = r;
  }

  return chats.map(c => ({
    ...c,
    jobTitle: jobById[c.job_id]?.title,
    zip: jobById[c.job_id]?.zip,
    customerName: nameById[c.customer_id],
    haulerName: nameById[c.hauler_id],
    assignedAdminName: c.assigned_admin_id ? nameById[c.assigned_admin_id] : null,
    latestRequest: latestRequestByChatId[c.id] || null,
  }));
}

export async function loadChatAdminSessions(chatId) {
  const { data, error } = await supabase.from("chat_admin_sessions").select("*").eq("chat_id", chatId).order("joined_at", { ascending: false });
  if (error) throw error;
  if (data.length === 0) return [];
  const adminIds = [...new Set(data.map(s => s.admin_id))];
  const { data: people } = await supabase.from("public_profiles").select("id, name").in("id", adminIds);
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.name]));
  return data.map(s => ({ ...s, adminName: nameById[s.admin_id] }));
}

export async function loadSupportRequestsForChat(chatId) {
  const { data, error } = await supabase.from("support_requests").select("*").eq("chat_id", chatId).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function loadChatAdminAuditLog(chatId) {
  const { data, error } = await supabase.from("chat_admin_audit_log").select("*").eq("chat_id", chatId).order("created_at", { ascending: false });
  if (error) throw error;
  if (data.length === 0) return [];
  const adminIds = [...new Set(data.map(a => a.admin_id))];
  const { data: people } = await supabase.from("public_profiles").select("id, name").in("id", adminIds);
  const nameById = Object.fromEntries((people || []).map(p => [p.id, p.name]));
  return data.map(a => ({ ...a, adminName: nameById[a.admin_id] }));
}

export async function joinChat(chatId) {
  const { error } = await supabase.rpc("admin_join_chat", { p_chat_id: chatId });
  if (error) throw error;
}

export async function leaveChat(chatId) {
  const { error } = await supabase.rpc("admin_leave_chat", { p_chat_id: chatId });
  if (error) throw error;
}

export async function lockChat(chatId, reason) {
  const { error } = await supabase.rpc("admin_lock_chat", { p_chat_id: chatId, p_reason: reason || null });
  if (error) throw error;
}

export async function unlockChat(chatId) {
  const { error } = await supabase.rpc("admin_unlock_chat", { p_chat_id: chatId });
  if (error) throw error;
}

export async function resolveSupportRequest(requestId, note) {
  const { error } = await supabase.rpc("admin_resolve_support", { p_request_id: requestId, p_resolution_note: note || null });
  if (error) throw error;
}

export async function reopenSupportRequest(chatId, note) {
  const { error } = await supabase.rpc("admin_reopen_support", { p_chat_id: chatId, p_note: note || null });
  if (error) throw error;
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
// - totalRefunded: every succeeded payments row of kind='refund' *for a full-payment job* —
//   switch-bid deltas and cancellations alike. request_cancellation has no payment_mode
//   restriction (only hauler-switching is full-mode-only), so a deposit-mode job's cancellation
//   refund is also kind='refund' and must be excluded here or it inflates this full-payment-only
//   figure with money that belongs to the deposit-mode table instead.
// effectiveAmount/effectiveCommission prefer locked_final_price over the accept-time bid_amount
// snapshot — a full-mode job renegotiated at scheduling time (ScheduleProposal) has a locked
// price that can differ from what the bid was originally accepted at, and bid_amount/commission
// are deliberately never rewritten (append-only — see 20260803000000_full_payment_scheduling.sql).
// Prefers the chat's own stamped commission_rate (frozen at accept_bid time — see
// 20260817000000_platform_fee_config.sql) so this recompute stays correct per-job even after the
// admin changes the global/tier fee; 0.10 is only a fallback for chats booked before that column
// existed (commission_rate null).
function effectiveAmount(c) {
  return c.locked_final_price != null ? Number(c.locked_final_price) : Number(c.bid_amount);
}
function effectiveCommission(c) {
  return c.locked_final_price != null ? Math.round(Number(c.locked_final_price) * (c.commission_rate ?? 0.10) * 100) / 100 : Number(c.commission);
}

export async function loadFullPaymentSummary() {
  const [{ data: chats, error: chatsError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from("chats").select(`
      bid_amount, commission, commission_rate, commission_status, locked_final_price, authorized_at,
      coordination_deadline, coordination_extended_at, stalled_at, locked_service_date,
      jobs!inner(status)
    `).eq("payment_mode", "full").is("superseded_at", null),
    supabase.from("payments").select("amount, kind, jobs!inner(payment_mode)").eq("status", "succeeded").eq("jobs.payment_mode", "full"),
  ]);
  if (chatsError) throw chatsError;
  if (paymentsError) throw paymentsError;

  // Nothing is actually held until authorized — a booked-but-still-coordinating job (no date
  // locked yet) hasn't had a cent moved, even though commission_status is still 'held' for it
  // (that flag only flips at completion). A chat with none of the coordination/lock columns set
  // predates the scheduling rework entirely — it was charged in full at accept under the old
  // flow, so it still counts as held from the moment it's booked.
  const fundsHeld = (chats || [])
    .filter(c => c.commission_status === "held" && c.jobs?.status === "booked" && (
      c.authorized_at || !(c.coordination_deadline || c.coordination_extended_at || c.stalled_at || c.locked_service_date)
    ))
    .reduce((sum, c) => sum + effectiveAmount(c), 0);
  const releasedToHaulers = (chats || [])
    .filter(c => c.commission_status === "earned")
    .reduce((sum, c) => sum + (effectiveAmount(c) - effectiveCommission(c)), 0);
  const platformEarned = (chats || [])
    .filter(c => c.commission_status === "earned")
    .reduce((sum, c) => sum + effectiveCommission(c), 0);
  const totalRefunded = (payments || [])
    .filter(p => p.kind === "refund")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  return { fundsHeld, releasedToHaulers, platformEarned, totalRefunded };
}
