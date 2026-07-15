import { supabase } from "../lib/supabaseClient";
import { loadOpenJobsForHauler } from "../jobs/data";

export async function loadCustomerStats(customerId) {
  const [{ data: jobs, error: jobsError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from("jobs").select("id, status, completed").eq("customer_id", customerId),
    // RLS already scopes this to jobs this customer owns — no extra filter needed.
    supabase.from("payments").select("amount").eq("status", "succeeded"),
  ]);
  if (jobsError) throw jobsError;
  if (paymentsError) throw paymentsError;

  const active = jobs.filter(j => j.status === "open" || j.status === "pending_verification").length;
  const inProgress = jobs.filter(j => j.status === "booked" && !j.completed).length;
  const completed = jobs.filter(j => j.status === "booked" && j.completed).length;
  const totalSpent = payments.reduce((sum, p) => sum + Number(p.amount), 0);

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
    supabase.from("chats").select("bid_amount, commission_status, jobs(completed)").eq("hauler_id", haulerId),
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
    .select("id, amount, status, created_at, job_id, chat_id, jobs(title), chats(hauler_id)")
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
    createdAt: p.created_at,
  }));
}

export async function loadHaulerEarnings(haulerId) {
  const { data, error } = await supabase
    .from("payments")
    .select("id, amount, status, created_at, job_id, chat_id, jobs(title), chats(customer_id)")
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

export async function updateNotificationPrefs(id, prefs) {
  const { error } = await supabase.from("profiles").update({ notification_prefs: prefs }).eq("id", id);
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

export async function deactivateOwnAccount(id) {
  const { error } = await supabase.from("profiles").update({ active: false, deactivated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
  await supabase.auth.signOut();
}
