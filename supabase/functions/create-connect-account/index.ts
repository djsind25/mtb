// create-connect-account
//
// First step of hauler onboarding for the Stripe Connect Express payment rework. Called once,
// the first time a hauler starts onboarding — creates their Express connected account and
// persists the id. If an account already exists on the profile, this is a no-op that just
// returns the existing id, so the frontend can safely call it again (e.g. after a page refresh)
// without creating a second orphaned Stripe account.
//
// This function only creates the account shell. It does not itself grant any bidding
// eligibility — profiles.stripe_connect_charges_enabled/payouts_enabled stay false until Stripe's
// account.updated webhook confirms onboarding actually finished (see stripe-webhook/index.ts and
// apply_connect_account_status()), and bids_enforce_connect_onboarded blocks bidding until then.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const haulerId = ctx.userClaims!.id;

    const { data: profile, error: profileError } = await ctx.supabase
      .from("profiles")
      .select("email, stripe_connect_account_id")
      .eq("id", haulerId)
      .single();
    if (profileError || !profile) {
      return Response.json({ message: "Could not load your profile." }, { status: 400 });
    }

    if (profile.stripe_connect_account_id) {
      return Response.json({ accountId: profile.stripe_connect_account_id });
    }

    let account: Stripe.Account;
    try {
      account = await stripe.accounts.create({
        type: "express",
        email: profile.email ?? undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual",
      });
    } catch (err) {
      console.error("create-connect-account: Stripe account creation failed:", err);
      return Response.json({ message: "Could not start Stripe onboarding. Please try again." }, { status: 502 });
    }

    // One-time-set only (see set_own_connect_account_id's WHERE clause) — if this somehow races
    // with another request that already set an id, the RPC raises and we surface that rather than
    // silently orphaning the Stripe account we just created.
    const { error: rpcError } = await ctx.supabase.rpc("set_own_connect_account_id", { p_account_id: account.id });
    if (rpcError) {
      console.error("create-connect-account: could not persist account id:", rpcError, { accountId: account.id });
      return Response.json({ message: "Stripe account was created but we couldn't save it. Contact support." }, { status: 502 });
    }

    return Response.json({ accountId: account.id });
  }),
};
