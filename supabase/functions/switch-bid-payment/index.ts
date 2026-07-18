// switch-bid-payment
//
// Lets a customer reassign a booked job's accepted hauler to a different bidder before work
// begins. Held funds stay held — only the delta between the old and new bid amount moves:
//   - delta == 0: no Stripe call at all, switch finalizes immediately.
//   - delta < 0: refunds the difference against the job's most recent successful charge, then
//     finalizes immediately (refunds are synchronous — no card interaction needed).
//   - delta > 0: creates a PaymentIntent for just the difference and returns its clientSecret;
//     the switch itself does NOT happen yet. The frontend confirms payment client-side (same
//     Stripe Elements pattern as accepting a bid), then calls this function again with
//     paymentIntentId so the switch can be finalized only once money has actually moved.
//
// preview_bid_switch/finalize_bid_switch (see 20260723000000_switch_accepted_bid.sql) do the
// validation and bookkeeping; this function's job is purely the Stripe side and deciding which
// of the three paths above applies. finalize_bid_switch is service-role-only — it trusts whatever
// kind/amount/paymentIntentId it's given, so this function must only call it after Stripe has
// actually confirmed that amount moved, never before.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { jobId, newBidId, paymentIntentId } = await req.json().catch(() => ({}));
    if (!jobId || !newBidId) {
      return Response.json({ message: "jobId and newBidId are required" }, { status: 400 });
    }

    const { data: preview, error: previewError } = await ctx.supabase
      .rpc("preview_bid_switch", { p_job_id: jobId, p_new_bid_id: newBidId })
      .single();
    if (previewError || !preview) {
      return Response.json({ message: previewError?.message ?? "Could not preview this switch" }, { status: 400 });
    }
    const { delta, current_chat_id: currentChatId } = preview as { delta: number; current_chat_id: string };
    const customerId = ctx.userClaims!.id;

    // Step 2 of the delta > 0 path: a clientSecret was already issued, the frontend confirmed
    // payment, and we're being asked to finalize now that money has actually moved.
    if (paymentIntentId) {
      let intent: Stripe.PaymentIntent;
      try {
        intent = await stripe.paymentIntents.retrieve(paymentIntentId);
      } catch (err) {
        console.error("switch-bid-payment: could not retrieve PaymentIntent:", err);
        return Response.json({ message: "Could not verify payment status." }, { status: 502 });
      }
      if (intent.status !== "succeeded" || intent.metadata.jobId !== jobId || intent.metadata.newBidId !== newBidId) {
        return Response.json({ message: "Payment has not succeeded for this switch." }, { status: 400 });
      }

      const { data: finalized, error: finalizeError } = await ctx.supabaseAdmin
        .rpc("finalize_bid_switch", {
          p_job_id: jobId, p_new_bid_id: newBidId, p_customer_id: customerId,
          p_kind: "charge", p_amount: intent.amount / 100, p_stripe_payment_intent_id: paymentIntentId,
        })
        .single();
      if (finalizeError || !finalized) {
        console.error("switch-bid-payment: finalize after successful charge failed:", finalizeError);
        return Response.json({ message: "Payment succeeded but we couldn't complete the switch. Contact support." }, { status: 502 });
      }
      return Response.json({ finalized: true, ...finalized });
    }

    if (delta === 0) {
      const { data: finalized, error: finalizeError } = await ctx.supabaseAdmin
        .rpc("finalize_bid_switch", { p_job_id: jobId, p_new_bid_id: newBidId, p_customer_id: customerId })
        .single();
      if (finalizeError || !finalized) {
        return Response.json({ message: finalizeError?.message ?? "Could not complete this switch" }, { status: 400 });
      }
      return Response.json({ finalized: true, ...finalized });
    }

    if (delta < 0) {
      const { data: latestCharge, error: chargeError } = await ctx.supabaseAdmin
        .rpc("latest_job_charge", { p_job_id: jobId })
        .single();
      if (chargeError || !latestCharge?.stripe_payment_intent_id) {
        return Response.json({ message: "Could not find the original payment to refund against." }, { status: 400 });
      }
      try {
        await stripe.refunds.create({
          payment_intent: latestCharge.stripe_payment_intent_id,
          amount: Math.round(-delta * 100),
        });
      } catch (err) {
        console.error("switch-bid-payment: refund failed:", err);
        return Response.json({ message: "Could not process the refund for this switch. Please try again or contact support." }, { status: 502 });
      }

      const { data: finalized, error: finalizeError } = await ctx.supabaseAdmin
        .rpc("finalize_bid_switch", {
          p_job_id: jobId, p_new_bid_id: newBidId, p_customer_id: customerId,
          p_kind: "refund", p_amount: -delta, p_stripe_payment_intent_id: latestCharge.stripe_payment_intent_id,
        })
        .single();
      if (finalizeError || !finalized) {
        console.error("switch-bid-payment: finalize after successful refund failed:", finalizeError);
        return Response.json({ message: "The refund went through but we couldn't complete the switch. Contact support." }, { status: 502 });
      }
      return Response.json({ finalized: true, ...finalized });
    }

    // delta > 0, step 1: create a PaymentIntent for just the difference and hand it back —
    // nothing in the DB changes until the frontend confirms this succeeded.
    try {
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(delta * 100),
        currency: "usd",
        // See create-deposit-intent for why: redirect-based methods need a return_url we don't
        // supply, and this app confirms in-place without navigating away.
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: { jobId, newBidId, customerId, currentChatId, kind: "bidSwitchDelta" },
      });
      return Response.json({ finalized: false, clientSecret: intent.client_secret, delta });
    } catch (err) {
      console.error("switch-bid-payment: PaymentIntent creation failed:", err);
      return Response.json({ message: "Could not start payment for this switch." }, { status: 502 });
    }
  }),
};
