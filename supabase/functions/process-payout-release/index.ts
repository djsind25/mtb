// process-payout-release
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by finalize_completion() whenever a job
// is confirmed complete — either the customer acknowledges it, or the 48h auto-release window
// elapses with no response. Not meant to be called by end users — auth is a shared secret header,
// checked manually below, same pattern as send-notification.
//
// This does the one real Stripe call that actually moves the hauler's share out of the platform's
// balance: a plain transfers.create() to their Connect account (the platform charge itself was
// already captured in full at booking — see create-booking-charge — so this is a pure internal
// balance movement, not a new charge). Idempotent on `status='pending'`: if this fires twice for
// the same payout (a retried delivery, or a duplicate pg_net call), the second attempt finds the
// row already `paid` and no-ops rather than double-transferring.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";
import { timingSafeEqualString } from "../_shared/timingSafeEqual.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});
const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (!internalKey || !timingSafeEqualString(req.headers.get("apikey") ?? "", internalKey)) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { payoutId } = await req.json().catch(() => ({}));
    if (!payoutId) {
      return Response.json({ message: "payoutId is required" }, { status: 400 });
    }

    const { data: payout, error: loadError } = await ctx.supabaseAdmin
      .from("payouts")
      .select("id, status, amount, stripe_connect_account_id, chat_id")
      .eq("id", payoutId)
      .maybeSingle();
    if (loadError || !payout) {
      console.error("process-payout-release: could not load payout", payoutId, loadError);
      return Response.json({ message: "Payout not found" }, { status: 404 });
    }
    if (payout.status !== "pending") {
      // Already handled (or already failed) — nothing to do. Not an error: this is the expected
      // shape of a duplicate delivery.
      return Response.json({ ok: true, alreadyProcessed: true });
    }

    const { data: chat } = await ctx.supabaseAdmin
      .from("chats")
      .select("transfer_group")
      .eq("id", payout.chat_id)
      .maybeSingle();

    try {
      const transfer = await stripe.transfers.create({
        amount: Math.round(Number(payout.amount) * 100),
        currency: "usd",
        destination: payout.stripe_connect_account_id,
        transfer_group: chat?.transfer_group ?? undefined,
      });

      const { error: updateError } = await ctx.supabaseAdmin
        .from("payouts")
        .update({ status: "paid", stripe_transfer_id: transfer.id, released_at: new Date().toISOString() })
        .eq("id", payoutId)
        .eq("status", "pending"); // re-check at write time — closes the race with a concurrent duplicate delivery
      if (updateError) throw updateError;

      return Response.json({ ok: true, transferId: transfer.id });
    } catch (err) {
      console.error("process-payout-release: transfer failed for payout", payoutId, err);
      await ctx.supabaseAdmin
        .from("payouts")
        .update({ status: "failed" })
        .eq("id", payoutId)
        .eq("status", "pending");
      return Response.json({ message: "Transfer failed" }, { status: 502 });
    }
  }),
};
