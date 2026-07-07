// create-deposit-intent
//
// Called by a signed-in customer when they tap "Accept bid". Recomputes the price
// server-side (via the accept_bid RPC — never trusts a client-supplied amount), books the
// job, opens the chat, then creates a plain Stripe PaymentIntent for the 10% deposit.
//
// Per the Scope of Work, v1 is deposit-only: standard PaymentIntents, NOT Stripe Connect.
// The full bid amount is never charged or held — only the deposit.

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

    const { chat_id: chatId, deposit, balance_due: balanceDue, commission, bid_amount: bidAmount } = accepted as {
      chat_id: string; deposit: number; balance_due: number; commission: number; bid_amount: number;
    };

    try {
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(deposit * 100),
        currency: "usd",
        automatic_payment_methods: { enabled: true },
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
