import { supabase } from "../lib/supabaseClient";

export async function loadMyChats(userId) {
  const { data: chats, error } = await supabase
    .from("chats")
    .select("*")
    .or(`customer_id.eq.${userId},hauler_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (chats.length === 0) return [];

  const jobIds = [...new Set(chats.map(c => c.job_id))];
  const otherIds = [...new Set(chats.flatMap(c => [c.customer_id, c.hauler_id]))];
  const chatIds = chats.map(c => c.id);

  const [{ data: jobs, error: jobsError }, { data: profiles, error: profilesError }, { data: recentMessages, error: msgError }] = await Promise.all([
    supabase.from("jobs").select("id, title").in("id", jobIds),
    supabase.from("public_profiles").select("id, name, business_name").in("id", otherIds),
    supabase.from("messages").select("chat_id, sender_id, text, created_at").in("chat_id", chatIds).order("created_at", { ascending: false }),
  ]);
  if (jobsError) throw jobsError;
  if (profilesError) throw profilesError;
  if (msgError) throw msgError;

  const jobById = Object.fromEntries(jobs.map(j => [j.id, j.title]));
  const profileById = Object.fromEntries(profiles.map(p => [p.id, p]));
  // Ordered newest-first, so the first row seen per chat_id is that chat's latest message.
  const lastMsgByChatId = {};
  for (const m of recentMessages) {
    if (!lastMsgByChatId[m.chat_id]) lastMsgByChatId[m.chat_id] = m;
  }

  return chats.map(c => {
    const isCustomer = c.customer_id === userId;
    const lastReadAt = isCustomer ? c.customer_last_read_at : c.hauler_last_read_at;
    const lastMsg = lastMsgByChatId[c.id];
    const unread = !!lastMsg && lastMsg.sender_id !== userId && (!lastReadAt || lastMsg.created_at > lastReadAt);
    return {
      ...c,
      jobTitle: jobById[c.job_id],
      customerName: profileById[c.customer_id]?.name,
      businessName: profileById[c.hauler_id]?.business_name,
      lastMessagePreview: lastMsg?.text,
      lastMessageAt: lastMsg?.created_at,
      unread,
    };
  });
}

export async function markChatRead(chatId, role) {
  const column = role === "customer" ? "customer_last_read_at" : "hauler_last_read_at";
  const { error } = await supabase.from("chats").update({ [column]: new Date().toISOString() }).eq("id", chatId);
  if (error) throw error;
}

export async function loadChat(chatId) {
  const { data: chat, error } = await supabase.from("chats").select("*").eq("id", chatId).single();
  if (error) throw error;
  const [{ data: job }, { data: profiles }] = await Promise.all([
    supabase.from("jobs").select("id, title").eq("id", chat.job_id).single(),
    supabase.from("public_profiles").select("id, name, business_name").in("id", [chat.customer_id, chat.hauler_id]),
  ]);
  const profileById = Object.fromEntries(profiles.map(p => [p.id, p]));
  return {
    ...chat,
    jobTitle: job?.title,
    customerName: profileById[chat.customer_id]?.name,
    businessName: profileById[chat.hauler_id]?.business_name,
  };
}

export async function loadMessages(chatId) {
  const { data, error } = await supabase.from("messages").select("*").eq("chat_id", chatId).order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function sendMessage({ chatId, senderRole, senderId, text }) {
  const { error } = await supabase.from("messages").insert({ chat_id: chatId, sender_role: senderRole, sender_id: senderId, text });
  if (error) throw error;
}

export async function loadReviews(chatId) {
  const { data, error } = await supabase.from("reviews").select("*").eq("chat_id", chatId);
  if (error) throw error;
  return data;
}

export async function submitReview({ chatId, reviewerRole, rating, text }) {
  const { error } = await supabase.from("reviews").upsert(
    { chat_id: chatId, reviewer_role: reviewerRole, rating, text },
    { onConflict: "chat_id,reviewer_role" },
  );
  if (error) throw error;
}
