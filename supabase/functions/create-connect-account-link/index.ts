// create-connect-account-link
//
// Returns a fresh Stripe-hosted onboarding URL for the caller's Connect account. Reused for both
// the very first onboarding attempt and any later "refresh" (Stripe's account-link URLs expire
// after a few minutes, and refresh_url points back at whatever calls this same function again —
// there's no functional difference between a first link and a refresh from the platform's side,
// so one function covers both rather than keeping two near-duplicates in sync).
//
// Requires create-connect-account to have already run (stripe_connect_account_id set) — this
// function does not create an account itself.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});
const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:4173";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const haulerId = ctx.userClaims!.id;

    const { data: profile, error: profileError } = await ctx.supabase
      .from("profiles")
      .select("stripe_connect_account_id")
      .eq("id", haulerId)
      .single();
    if (profileError || !profile?.stripe_connect_account_id) {
      return Response.json({ message: "Start onboarding before requesting a link." }, { status: 400 });
    }

    try {
      // This app has no path-based router (see App.jsx's ?admin_invite=/?role= convention) — the
      // return/refresh destinations are plain query params on the root, handled by
      // HaulerConnectOnboarding.jsx.
      const link = await stripe.accountLinks.create({
        account: profile.stripe_connect_account_id,
        refresh_url: `${siteUrl}/?connect_refresh=1`,
        return_url: `${siteUrl}/?connect_return=1`,
        type: "account_onboarding",
      });
      return Response.json({ url: link.url });
    } catch (err) {
      console.error("create-connect-account-link: Stripe account link creation failed:", err);
      return Response.json({ message: "Could not open Stripe onboarding right now. Please try again." }, { status: 502 });
    }
  }),
};
