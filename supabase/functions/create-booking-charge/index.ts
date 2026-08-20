// create-booking-charge
//
// Called by a signed-in customer when they tap "Accept bid". Recomputes the price server-side
// (via the accept_bid RPC — never trusts a client-supplied amount), books the job, opens the
// chat, then creates a plain Stripe PaymentIntent for the full bid amount plus the platform's
// service fee.
//
// Stripe Connect Express payment rework: this replaces the old deposit-only model (10% now, 90%
// paid to the hauler off-platform) and the old "full payment" mode (nothing charged until a
// simulated, non-Stripe authorize/capture near the service date — see the git history for
// perform_authorization()/finalize_completion(), removed once nothing called them anymore). Now
// every job is charged in full, for real, and captured immediately at acceptance —
// `capture_method` is left at Stripe's default `automatic`. This is deliberate, not an oversight:
// a job can have up to a 30-day window between booking and completion, and Stripe card
// authorization holds don't reliably survive anywhere near that long. The money sits captured in
// the platform's own Stripe balance (a plain PaymentIntent, not a destination charge) until a
// later release step transfers the hauler's share to their Connect account once the customer
// approves completion.

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

    // Recomputes bid/commission/service-fee from the DB and atomically books the job, opens the
    // chat, and records a pending payment row. Runs as the caller (their JWT is forwarded), so
    // accept_bid's internal auth.uid() check confirms they own the job.
    const { data: accepted, error: acceptError } = await ctx.supabase
      .rpc("accept_bid", { p_job_id: jobId, p_bid_id: bidId })
      .single();

    if (acceptError || !accepted) {
      return Response.json({ message: acceptError?.message ?? "Could not accept bid" }, { status: 400 });
    }

    const { chat_id: chatId, deposit: bidAmount, commission, service_fee: serviceFee } = accepted as {
      chat_id: string; deposit: number; balance_due: number; commission: number; bid_amount: number; payment_mode: string; service_fee: number;
    };
    const totalCharge = bidAmount + serviceFee;

    try {
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(totalCharge * 100),
        currency: "usd",
        // allow_redirects: "never" — the frontend confirms with redirect: "if_required" and no
        // return_url; without this, Stripe would offer redirect-based methods (Klarna, Affirm,
        // Amazon Pay) that require one, and confirmation fails. Card, Cash App, and Link all
        // still work fine with no redirect.
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        transfer_group: `job_${jobId}`,
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
        bidAmount,
        serviceFee,
        totalCharge,
        commission,
      });
    } catch (err) {
      // Stripe (or the follow-up DB write) failed after the job was already booked —
      // undo the booking so the customer isn't left stuck mid-flow and can retry.
      // rollback_bid_acceptance() runs the whole unwind (notifications, payments, chat, job
      // status) as one PL/pgSQL function body, so it's atomic — either the booking is fully
      // reverted or none of it is.
      const { error: rollbackError } = await ctx.supabaseAdmin.rpc("rollback_bid_acceptance", {
        p_job_id: jobId,
        p_chat_id: chatId,
      });
      if (rollbackError) {
        // The booking is now in an inconsistent state that automatic rollback couldn't fix —
        // surface loudly rather than returning a generic message that hides it.
        console.error("create-booking-charge: rollback_bid_acceptance failed after Stripe error:", rollbackError, "original error:", err);
        return Response.json({ message: "Payment setup failed and automatic cleanup also failed. Contact support." }, { status: 500 });
      }

      console.error("create-booking-charge failed:", err);
      return Response.json({ message: "Payment setup failed. Please try accepting the bid again." }, { status: 502 });
    }
  }),
};
