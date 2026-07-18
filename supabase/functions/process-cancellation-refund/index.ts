// process-cancellation-refund
//
// Admin-invoked: resolves a pending cancellation request by refunding p_amount from the job's
// held funds. A job switched more than once can have more than one succeeded charge (each its own
// PaymentIntent) — job_refundable_charges returns them oldest-first with how much of each is
// still refundable, and this function splits the requested amount across as many of them as it
// takes via separate stripe.refunds.create calls, then books everything in one resolve_cancellation
// RPC call once every refund that was attempted has actually succeeded.
//
// Uses the admin's own session throughout (ctx.supabase, not ctx.supabaseAdmin) — resolve_cancellation
// checks is_full_admin() via auth.uid(), same trust model as every other admin-mutation RPC in this
// app (admin_review_completion, review_hauler_document, etc.), not the service-role lock
// finalize_bid_switch uses for its untrusted customer caller.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { requestId, jobId, refundAmount } = await req.json().catch(() => ({}));
    if (!requestId || !jobId || refundAmount == null) {
      return Response.json({ message: "requestId, jobId, and refundAmount are required" }, { status: 400 });
    }
    const amount = Number(refundAmount);
    if (!(amount >= 0)) {
      return Response.json({ message: "refundAmount must be a non-negative number" }, { status: 400 });
    }

    // Must check this *before* touching Stripe, not just rely on resolve_cancellation's own
    // status check at the end — job_refundable_charges only knows about the charge/refund
    // ledger, not about cancellation_requests at all, so without this an admin re-submitting
    // (or a second admin racing the first) on an already-resolved request would still refund
    // real money against Stripe before the finalize call ever rejects it as too late.
    const { data: request, error: requestError } = await ctx.supabase
      .from("cancellation_requests")
      .select("status")
      .eq("id", requestId)
      .single();
    if (requestError || !request) {
      return Response.json({ message: "Cancellation request not found." }, { status: 404 });
    }
    if (request.status !== "pending") {
      return Response.json({ message: "This request has already been resolved." }, { status: 400 });
    }

    const { data: charges, error: chargesError } = await ctx.supabase.rpc("job_refundable_charges", { p_job_id: jobId });
    if (chargesError) {
      return Response.json({ message: chargesError.message }, { status: 400 });
    }

    const totalRefundable = (charges || []).reduce((sum: number, c: { refundable: number }) => sum + Number(c.refundable), 0);
    if (amount > totalRefundable + 0.005) {
      return Response.json({ message: `Only $${totalRefundable.toFixed(2)} is available to refund on this job.` }, { status: 400 });
    }

    let remaining = Math.round(amount * 100);
    const refunds: { stripe_payment_intent_id: string; stripe_refund_id: string; amount: number }[] = [];
    for (const charge of charges || []) {
      if (remaining <= 0) break;
      const refundableCents = Math.round(Number(charge.refundable) * 100);
      if (refundableCents <= 0) continue;
      const take = Math.min(remaining, refundableCents);
      try {
        const refund = await stripe.refunds.create({ payment_intent: charge.stripe_payment_intent_id, amount: take });
        refunds.push({ stripe_payment_intent_id: charge.stripe_payment_intent_id, stripe_refund_id: refund.id, amount: take / 100 });
        remaining -= take;
      } catch (err) {
        console.error("process-cancellation-refund: refund failed partway through the split:", err);
        // Whatever refunds already succeeded above are real money that moved — book them now
        // rather than losing track of them just because a later refund in the split failed.
        if (refunds.length > 0) {
          const refundedSoFar = refunds.reduce((s, r) => s + r.amount, 0);
          const { error: partialError } = await ctx.supabase.rpc("resolve_cancellation", {
            p_request_id: requestId,
            p_refund_amount: refundedSoFar,
            p_retained_amount: totalRefundable - refundedSoFar,
            p_refunds: refunds,
          });
          if (partialError) console.error("process-cancellation-refund: could not book the partial refunds:", partialError);
        }
        return Response.json({ message: "Refund only partially completed — check Stripe and finish resolving this request manually." }, { status: 502 });
      }
    }

    const { error: finalizeError } = await ctx.supabase.rpc("resolve_cancellation", {
      p_request_id: requestId,
      p_refund_amount: amount,
      p_retained_amount: totalRefundable - amount,
      p_refunds: refunds,
    });
    if (finalizeError) {
      console.error("process-cancellation-refund: refunds succeeded but finalize failed:", finalizeError);
      return Response.json({ message: "Refund succeeded but we couldn't finish closing out the request. Contact support." }, { status: 502 });
    }
    return Response.json({ resolved: true, refundAmount: amount, retainedAmount: totalRefundable - amount });
  }),
};
