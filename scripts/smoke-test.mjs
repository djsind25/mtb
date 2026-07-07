// Smoke test for the local Supabase stack — exercises the core marketplace flow end to end:
// signup -> profiles -> post a job -> hauler radius-filtered job list -> submit a bid ->
// bidReceived notification -> accept-bid (Stripe deposit intent).
//
// Run against `supabase start` + `supabase functions serve --env-file supabase/.env`:
//   node scripts/smoke-test.mjs
//
// Prints the response at each step. With placeholder Stripe keys (the local dev default),
// the last step is expected to fail at Stripe and roll back the booking — that rollback
// path is itself part of what this test verifies. Once you set a real STRIPE_SECRET_KEY in
// supabase/.env, that step should instead return a clientSecret.

const BASE = "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: ANON,
      Authorization: `Bearer ${token || ANON}`,
      ...(body !== undefined ? { Prefer: "return=representation" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

function log(label, x) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(x, null, 2));
}

async function signUp(email, password) {
  const r = await req("POST", "/auth/v1/signup", { body: { email, password } });
  if (!r.json?.access_token) throw new Error(`signup failed for ${email}: ${JSON.stringify(r.json)}`);
  return { token: r.json.access_token, id: r.json.user.id };
}

const rand = Math.random().toString(36).slice(2, 8);

(async () => {
  const customer = await signUp(`cust_${rand}@test.com`, "testpass123456");
  const hauler = await signUp(`haul_${rand}@test.com`, "testpass123456");

  await req("POST", "/rest/v1/profiles", {
    token: customer.token,
    body: { id: customer.id, role: "customer", email: `cust_${rand}@test.com`, name: "Dave K.", zip: "60491" },
  });
  await req("POST", "/rest/v1/profiles", {
    token: hauler.token,
    body: { id: hauler.id, role: "hauler", email: `haul_${rand}@test.com`, name: "Jake Torres", business_name: "Capital City Haulers", zip: "60467" },
  });

  const jobRes = await req("POST", "/rest/v1/jobs", {
    token: customer.token,
    body: { customer_id: customer.id, title: "Old couch + mattress", description: "Curbside pickup", zip: "60491" },
  });
  log("post job", jobRes.json);
  const jobId = jobRes.json[0].id;

  const openJobs = await req("POST", "/rest/v1/rpc/list_open_jobs_for_hauler", { token: hauler.token, body: {} });
  log("list_open_jobs_for_hauler (expect the job above, with a distance_mi)", openJobs.json);

  const bidRes = await req("POST", "/rest/v1/bids", {
    token: hauler.token,
    body: { job_id: jobId, hauler_id: hauler.id, amount: 150, note: "I can do this today" },
  });
  log("submit bid", bidRes.json);
  const bidId = bidRes.json[0].id;

  await new Promise((r) => setTimeout(r, 500));
  const notifs = await req("GET", `/rest/v1/notifications?job_id=eq.${jobId}`, { token: SERVICE });
  log("bidReceived notification (auto-created by trigger)", notifs.json);

  const acceptRes = await fetch(`${BASE}/functions/v1/create-deposit-intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${customer.token}` },
    body: JSON.stringify({ jobId, bidId }),
  });
  log("create-deposit-intent response", { status: acceptRes.status, body: await acceptRes.json().catch(() => null) });

  const jobAfter = await req("GET", `/rest/v1/jobs?id=eq.${jobId}`, { token: SERVICE });
  log("job status after accept attempt", jobAfter.json);
})().catch((e) => {
  console.error("SMOKE TEST FAILED:", e);
  process.exit(1);
});
