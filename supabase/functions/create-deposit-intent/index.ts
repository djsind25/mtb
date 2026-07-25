// create-deposit-intent
//
// Called by a signed-in customer when they tap "Accept bid". Recomputes the price
// server-side (via the accept_bid RPC — never trusts a client-supplied amount), books the
// job, opens the chat, then creates a plain Stripe PaymentIntent for the 10% deposit.
//
// Per the Scope of Work, deposit mode is deposit-only: standard PaymentIntents, NOT Stripe
// Connect. The full bid amount is never charged or held — only the deposit.
//
// Full-payment mode is different since the scheduling/authorization rework
// (20260803000000_full_payment_scheduling.sql): accepting a bid no longer charges anything at
// all — the job just opens into a coordination window. accept_bid() already skips inserting a
// pending payments row for full mode, so there's nothing for this function to attach a
// PaymentIntent to; it returns immediately with requiresPayment: false and the frontend skips
// the Stripe step entirely (see AcceptBidPayment.jsx / BidRow.jsx). Money only moves later, via
// perform_authorization()/finalize_completion() once a service date is locked.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { jobId, bidId } = await req.json().catch(() => ({}));
    if (!jobId || !bidId) {
      return Response.json({ message: "jobId and bidId are required" }, { status: 400 });
    }

    // Recomputes deposit/balance/commission from the DB and atomically books the job,
    // opens the chat, and records a pending payment row. Runs as the caller (their JWT is
    // forwarded), so accept_bid's internal auth.uid() check confirms they own the job.
    const { data: accepted, error: acceptError } = await ctx.supabase
      .rpc("accept_bid", { p_job_id: jobId, p_bid_id: bidId })
      .single();

    if (acceptError || !accepted) {
      return Response.json({ message: acceptError?.message ?? "Could not accept bid" }, { status: 400 });
    }

    const { chat_id: chatId, deposit, balance_due: balanceDue, commission, bid_amount: bidAmount, payment_mode: paymentMode } = accepted as {
      chat_id: string; deposit: number; balance_due: number; commission: number; bid_amount: number; payment_mode: string;
    };

    if (paymentMode === "full") {
      return Response.json({ requiresPayment: false, chatId, deposit, balanceDue, commission, bidAmount });
    }

    try {
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(deposit * 100),
        currency: "usd",
        // allow_redirects: "never" — the frontend confirms with redirect: "if_required" and no
        // return_url; without this, Stripe would offer redirect-based methods (Klarna, Affirm,
        // Amazon Pay) that require one, and confirmation fails. Those don't fit an escrow-hold
        // model well anyway (refunding/holding works differently than a card); card, Cash App,
        // and Link all still work fine with no redirect.
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: { jobId, bidId, chatId, customerId: ctx.userClaims!.id },
      });

      const { error: updateError } = await ctx.supabaseAdmin
        .from("payments")
        .update({ stripe_payment_intent_id: intent.id, status: "processing" })
        .eq("job_id", jobId)
        .is("stripe_payment_intent_id", null);
      if (updateError) throw updateError;

      return Response.json({
        clientSecret: intent.client_secret,
        chatId,
        deposit,
        balanceDue,
        commission,
        bidAmount,
      });
    } catch (err) {
      // Stripe (or the follow-up DB write) failed after the job was already booked —
      // undo the booking so the customer isn't left stuck mid-flow and can retry.
      // Order matters: notifications and payments both reference chats.id without cascade,
      // so they have to go first or the chat delete fails on a FK violation and silently
      // leaves the chat behind.
      await ctx.supabaseAdmin.from("notifications").delete().eq("chat_id", chatId);
      await ctx.supabaseAdmin.from("payments").delete().eq("job_id", jobId).is("stripe_payment_intent_id", null);
      await ctx.supabaseAdmin.from("chats").delete().eq("id", chatId);
      await ctx.supabaseAdmin
        .from("jobs")
        .update({ status: "open", accepted_bid_id: null, accepted_at: null, complete_by: null })
        .eq("id", jobId);

      console.error("create-deposit-intent failed:", err);
      return Response.json({ message: "Payment setup failed. Please try accepting the bid again." }, { status: 502 });
    }
  }),
};
