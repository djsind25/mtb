import { supabase } from "../lib/supabaseClient";

export async function getOrCreateMySupportChat(userId) {
  const { data: existing, error: findError } = await supabase
    .from("support_chats").select("*").eq("user_id", userId).eq("status", "open").maybeSingle();
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

  const [{ data: profiles, error: profilesError }, { data: recentMessages, error: msgError }] = await Promise.all([
    profileIds.length ? supabase.from("public_profiles").select("id, name, business_name, role").in("id", profileIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("support_messages").select("support_chat_id, sender_id, text, created_at").in("support_chat_id", chatIds).order("created_at", { ascending: false }),
  ]);
  if (profilesError) throw profilesError;
  if (msgError) throw msgError;

  const profileById = Object.fromEntries(profiles.map(p => [p.id, p]));
  const lastMsgByChatId = {};
  for (const m of recentMessages) {
    if (!lastMsgByChatId[m.support_chat_id]) lastMsgByChatId[m.support_chat_id] = m;
  }

  return chats.map(c => {
    const requester = profileById[c.user_id];
    return {
      ...c,
      requesterName: requester?.business_name || requester?.name,
      requesterRole: requester?.role,
      assignedAdminName: profileById[c.assigned_admin_id]?.name,
      lastMessagePreview: lastMsgByChatId[c.id]?.text,
      lastMessageAt: lastMsgByChatId[c.id]?.created_at,
    };
  });
}

export async function closeSupportChat(id) {
  const { error } = await supabase.rpc("close_support_chat", { p_support_chat_id: id });
  if (error) throw error;
}
