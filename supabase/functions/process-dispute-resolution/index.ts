// process-dispute-resolution
//
// Admin-invoked: resolves a claimed dispute by refunding refundAmount from the job's held funds
// and/or reversing providerPayoutAmount's shortfall from any payout that already went out to the
// hauler. Structurally a copy of process-cancellation-refund (claim already done by the caller
// via claim_dispute_for_resolution, split the refund across job_refundable_charges, same
// partial-failure safety net) plus a second loop over job_reversible_payouts for the "hauler was
// already paid, now needs some of it clawed back" case that a pre-completion cancellation never
// has to handle.
//
// Uses the admin's own session throughout (ctx.supabase), same trust model as
// process-cancellation-refund — is_full_admin() is enforced by claim_dispute_for_resolution
// before any Stripe call happens.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { disputeId, jobId, resolution, refundAmount, providerPayoutAmount, note } = await req.json().catch(() => ({}));
    if (!disputeId || !jobId || !resolution) {
      return Response.json({ message: "disputeId, jobId, and resolution are required" }, { status: 400 });
    }
    if (resolution !== "resolved_customer" && resolution !== "resolved_provider") {
      return Response.json({ message: "resolution must be resolved_customer or resolved_provider" }, { status: 400 });
    }
    const refundTarget = Number(refundAmount) || 0;
    const providerTarget = Number(providerPayoutAmount) || 0;
    if (refundTarget < 0 || providerTarget < 0) {
      return Response.json({ message: "Amounts must be non-negative" }, { status: 400 });
    }

    // Same reasoning as process-cancellation-refund: claim before touching Stripe, not just at
    // the end via resolve_dispute's own is_full_admin()+status check.
    const { error: claimError } = await ctx.supabase.rpc("claim_dispute_for_resolution", { p_dispute_id: disputeId });
    if (claimError) {
      return Response.json({ message: claimError.message || "Could not claim this dispute." }, { status: 400 });
    }

    const refunds: { stripe_payment_intent_id: string; stripe_refund_id: string; amount: number }[] = [];
    const reversals: { payout_id: string; stripe_reversal_id: string; amount: number }[] = [];

    async function releaseClaimAndFail(message: string) {
      if (refunds.length === 0 && reversals.length === 0) {
        const { error: releaseError } = await ctx.supabase.rpc("release_dispute_claim", { p_dispute_id: disputeId });
        if (releaseError) console.error("process-dispute-resolution: could not release the claim:", releaseError);
      }
      return Response.json({ message }, { status: 502 });
    }

    // Refund portion — identical split-oldest-first logic to process-cancellation-refund.
    if (refundTarget > 0) {
      const { data: charges, error: chargesError } = await ctx.supabase.rpc("job_refundable_charges", { p_job_id: jobId });
      if (chargesError) return Response.json({ message: chargesError.message }, { status: 400 });

      const totalRefundable = (charges || []).reduce((sum: number, c: { refundable: number }) => sum + Number(c.refundable), 0);
      if (refundTarget > totalRefundable + 0.005) {
        await ctx.supabase.rpc("release_dispute_claim", { p_dispute_id: disputeId });
        return Response.json({ message: `Only $${totalRefundable.toFixed(2)} is available to refund on this job.` }, { status: 400 });
      }

      let remaining = Math.round(refundTarget * 100);
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
          console.error("process-dispute-resolution: refund failed partway through the split:", err);
          return releaseClaimAndFail("Refund only partially completed — check Stripe and finish resolving this dispute manually.");
        }
      }
    }

    // Reversal portion — only reachable if the hauler was already paid out before this dispute
    // was opened (a dispute filed after the job already shows completed).
    const alreadyPaidTotal = providerTarget >= 0
      ? (await ctx.supabase.rpc("job_reversible_payouts", { p_job_id: jobId })).data ?? []
      : [];
    const totalReversible = alreadyPaidTotal.reduce((sum: number, p: { reversible: number }) => sum + Number(p.reversible), 0);
    let reverseRemaining = Math.round(Math.max(0, totalReversible - providerTarget) * 100);
    for (const payout of alreadyPaidTotal) {
      if (reverseRemaining <= 0) break;
      const reversibleCents = Math.round(Number(payout.reversible) * 100);
      if (reversibleCents <= 0 || !payout.stripe_transfer_id) continue;
      const take = Math.min(reverseRemaining, reversibleCents);
      try {
        const reversal = await stripe.transfers.createReversal(payout.stripe_transfer_id, { amount: take });
        reversals.push({ payout_id: payout.payout_id, stripe_reversal_id: reversal.id, amount: take / 100 });
        reverseRemaining -= take;
      } catch (err) {
        console.error("process-dispute-resolution: transfer reversal failed partway through the split:", err);
        return releaseClaimAndFail("Reversal only partially completed — check Stripe and finish resolving this dispute manually.");
      }
    }

    const { error: finalizeError } = await ctx.supabase.rpc("resolve_dispute", {
      p_dispute_id: disputeId,
      p_status: resolution,
      p_refund_amount: refundTarget,
      p_provider_payout_amount: providerTarget,
      p_refunds: refunds,
      p_reversals: reversals,
      p_note: note ?? null,
    });
    if (finalizeError) {
      console.error("process-dispute-resolution: Stripe actions succeeded but finalize failed:", finalizeError);
      return Response.json({ message: "Refund/reversal succeeded but we couldn't finish closing out the dispute. Contact support." }, { status: 502 });
    }
    return Response.json({ resolved: true, refundAmount: refundTarget, providerPayoutAmount: providerTarget });
  }),
};
