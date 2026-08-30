import { supabase } from "../lib/supabaseClient";

// jobId scopes this to a per-job support thread (a separate line from the shared customer<->hauler
// chat — see get_or_create_job_support_chat()). The general (jobId omitted) path now filters
// job_id is null explicitly: once a user can have more than one open support_chats row (a general
// ticket plus one or more job-scoped threads), the old unfiltered query would match more than one
// row and .maybeSingle() would throw.
export async function getOrCreateMySupportChat(userId, jobId = null) {
  if (jobId) {
    const { data, error } = await supabase.rpc("get_or_create_job_support_chat", { p_job_id: jobId });
    if (error) throw error;
    return data;
  }

  const { data: existing, error: findError } = await supabase
    .from("support_chats").select("*").eq("user_id", userId).eq("status", "open").is("job_id", null).maybeSingle();
  if (findError) throw findError;
  if (existing) return existing;

  const { data, error } = await supabase.from("support_chats").insert({ user_id: userId }).select().single();
  if (error) throw error;
  return data;
}

export async function loadSupportMessages(supportChatId) {
  const { data, error } = await supabase.from("support_messages").select("*").eq("support_chat_id", supportChatId).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

// Every call site of SupportChatThread only ever kept the chat's id around, not its status — the
// thread itself now needs the real current status (a chat can arrive here already auto-closed)
// rather than assuming "open" the way it used to.
export async function loadSupportChatStatus(supportChatId) {
  const { data, error } = await supabase.from("support_chats").select("status, closed_at, closed_by").eq("id", supportChatId).single();
  if (error) throw error;
  return data;
}

export async function sendSupportMessage({ supportChatId, senderId, senderRole, text }) {
  const { error } = await supabase.from("support_messages").insert({ support_chat_id: supportChatId, sender_id: senderId, sender_role: senderRole, text });
  if (error) throw error;
}

// Admin-only (RLS: support_chats_select allows is_admin() to see every ticket, not just ones
// assigned to them — "any admin can pick this up" is the point). Loads every ticket regardless of
// status; the admin dashboard's Open/Closed/All sub-tabs filter this client-side, same pattern as
// the flagged-messages and overdue-completions tabs.
export async function loadSupportChats() {
  const { data: chats, error } = await supabase.from("support_chats").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  if (chats.length === 0) return [];

  // user_id is null for guest chats (inbound email with no matching profile) — PostgREST's
  // .in() errors on a literal null (reads it as the string "null", not SQL NULL), so filter
  // those out before building the query.
  const profileIds = [...new Set(chats.flatMap(c => [c.user_id, c.assigned_admin_id]).filter(Boolean))];
  const chatIds = chats.map(c => c.id);
  const jobIds = [...new Set(chats.map(c => c.job_id).filter(Boolean))];

  const [{ data: profiles, error: profilesError }, { data: recentMessages, error: msgError }, { data: jobRows, error: jobsError }] = await Promise.all([
    profileIds.length ? supabase.from("public_profiles").select("id, name, business_name, role").in("id", profileIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("support_messages").select("support_chat_id, sender_id, sender_role, text, created_at").in("support_chat_id", chatIds).order("created_at", { ascending: false }),
    jobIds.length ? supabase.from("jobs").select("id, title").in("id", jobIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (profilesError) throw profilesError;
  if (msgError) throw msgError;
  if (jobsError) throw jobsError;

  const profileById = Object.fromEntries(profiles.map(p => [p.id, p]));
  const jobTitleById = Object.fromEntries(jobRows.map(j => [j.id, j.title]));
  const lastMsgByChatId = {};
  for (const m of recentMessages) {
    if (!lastMsgByChatId[m.support_chat_id]) lastMsgByChatId[m.support_chat_id] = m;
  }

  // getOrCreateMySupportChat() (and its job-scoped counterpart) insert the row the moment the
  // "Contact Administrator" / "Contact support about this job" panel is opened, before anyone has
  // typed anything — someone who opens it and closes it without sending a message leaves behind a
  // permanent row with zero messages. That's not a real ticket: nothing to review, nothing to
  // reply to, and it was inflating the admin "open chat tickets" count with chats no customer ever
  // actually used. Filtered out here, at the source, rather than in AdminDashboard's queue math, so
  // every screen this feeds (open/closed/all, general and per-job) agrees.
  return chats.filter(c => !!lastMsgByChatId[c.id]).map(c => {
    const requester = profileById[c.user_id];
    const lastMsg = lastMsgByChatId[c.id];
    return {
      ...c,
      requesterName: requester?.business_name || requester?.name,
      requesterRole: requester?.role,
      assignedAdminName: profileById[c.assigned_admin_id]?.name,
      lastMessagePreview: lastMsg?.text,
      lastMessageAt: lastMsg?.created_at,
      jobTitle: c.job_id ? jobTitleById[c.job_id] : null,
      // "Needs reply" = still open and the last word was the requester's, not admin's.
      needsReply: c.status === "open" && !!lastMsg && lastMsg.sender_role !== "admin",
    };
  });
}

export async function closeSupportChat(id) {
  const { error } = await supabase.rpc("close_support_chat", { p_support_chat_id: id });
  if (error) throw error;
}

export async function reopenSupportChat(id) {
  const { error } = await supabase.rpc("reopen_support_chat", { p_support_chat_id: id });
  if (error) throw error;
}
