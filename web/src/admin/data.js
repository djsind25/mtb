import { supabase } from "../lib/supabaseClient";

export async function loadUsers() {
  const { data, error } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
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

  return jobs.map(j => ({
    ...j,
    customerName: nameById[j.customer_id],
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
