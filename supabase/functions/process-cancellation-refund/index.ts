// process-cancellation-refund
//
// Admin-invoked: resolves a pending cancellation request by refunding p_amount from the job's
// held funds. A job switched more than once can have more than one succeeded charge (each its own
// PaymentIntent) — job_refundable_charges returns them oldest-first with how much of each is
// still refundable, and this function splits the requested amount across as many of them as it
// takes via separate stripe.refunds.create calls, then books everything in one resolve_cancellation
// RPC call once every refund that was attempted has actually succeeded.
//
// Uses the admin's own session throughout (ctx.supabase, not ctx.supabaseAdmin) — same trust model
// as every other admin-mutation RPC in this app (admin_review_completion, review_hauler_document,
// etc.), not the service-role lock finalize_bid_switch uses for its untrusted customer caller.
// is_full_admin() is checked up front via claim_cancellation_for_refund, before any Stripe call —
// job_refundable_charges below only checks is_admin() (it's also used read-only by read-only
// admins to display the held amount), so it can't be the thing standing between a read-only admin
// and a real refund.

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

    // Must claim this *before* touching Stripe, not just rely on resolve_cancellation's own
    // is_full_admin()+status check at the end. Two problems with only checking there: (1) that
    // check happens after the refund already went through, so a read-only admin (blocked from
    // is_full_admin(), but not from is_admin() — which is all job_refundable_charges below
    // checks) could still trigger a real Stripe refund before ever being rejected; (2) a plain
    // status read has no lock, so two near-simultaneous calls on the same request (a second
    // admin racing the first, or a double-submit) could both read "pending" and both refund.
    // claim_cancellation_for_refund closes both: it checks is_full_admin() itself, and claims
    // the request via a single atomic UPDATE ... WHERE status='pending' AND refund_in_progress
    // = false, so only one caller's claim can ever succeed.
    const { error: claimError } = await ctx.supabase.rpc("claim_cancellation_for_refund", { p_request_id: requestId });
    if (claimError) {
      return Response.json({ message: claimError.message || "Could not claim this request." }, { status: 400 });
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
        if (refunds.length > 0) {
          // Whatever refunds already succeeded above are real money that moved — book them now
          // rather than losing track of them just because a later refund in the split failed.
          // resolve_cancellation fully resolves the request either way, so no claim to release.
          const refundedSoFar = refunds.reduce((s, r) => s + r.amount, 0);
          const { error: partialError } = await ctx.supabase.rpc("resolve_cancellation", {
            p_request_id: requestId,
            p_refund_amount: refundedSoFar,
            p_retained_amount: totalRefundable - refundedSoFar,
            p_refunds: refunds,
          });
          if (partialError) console.error("process-cancellation-refund: could not book the partial refunds:", partialError);
        } else {
          // Nothing moved at all — release the claim so this request isn't stuck looking
          // "in progress" forever and can be retried cleanly.
          const { error: releaseError } = await ctx.supabase.rpc("release_cancellation_claim", { p_request_id: requestId });
          if (releaseError) console.error("process-cancellation-refund: could not release the claim:", releaseError);
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
