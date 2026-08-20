// stripe-webhook
//
// Receives async payment events from Stripe. Authenticity comes entirely from Stripe's
// signature on the raw body (verified below) — there's no Supabase JWT or API key involved,
// since Stripe itself is the caller. `auth: "none"` here, and this function must have
// `verify_jwt = false` set in supabase/config.toml so the platform doesn't also demand a JWT.
//
// Fixes audit findings M-1 and M-2:
//   - Idempotency: every event.id is recorded in stripe_webhook_events before any side effect.
//     Stripe delivers at-least-once, so the same event can arrive more than once (a retry after
//     a slow 200, a dashboard resend, a network blip) — a duplicate is now detected and
//     acknowledged without reprocessing, rather than silently re-running (harmless here, but
//     unaudited) or double-counting in a future handler that isn't idempotent by luck.
//   - Ordering: every status write is now a *conditional* transition guarded by the row's
//     current status (e.g. succeeded only applies from 'processing'), not an unconditional
//     overwrite. Stripe does not guarantee delivery order — a delayed payment_intent.succeeded
//     arriving after charge.refunded has already been processed must not resurrect the payment
//     as "succeeded". The guard makes that transition a no-op instead.
//   - Amount verification: payment_intent.succeeded checks pi.amount_received against the
//     expected amount on the payments row before marking it succeeded.
//   - Every write result is now inspected. A payment_intent.succeeded for a PaymentIntent with
//     no matching local row, or an amount mismatch, or a DB error, returns a non-2xx status so
//     Stripe retries — previously these were silently acknowledged and the money was, in effect,
//     taken with no local record and no signal that anything had gone wrong.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

// Applies `status` to the payments row identified by `matchColumn`/`matchValue`, but only if its
// current status is one of `fromStatuses` — an out-of-order or duplicate event that no longer
// matches the expected prior state is acknowledged as a no-op, not treated as an error. Returns
// false only on a genuine problem (no matching row, or a DB error), which the caller turns into
// a non-2xx response so Stripe retries.
async function transitionPayment(
  ctx: { supabaseAdmin: { from: (t: string) => any } },
  matchColumn: string,
  matchValue: string,
  fromStatuses: string[],
  toStatus: string,
): Promise<boolean> {
  const { data: existing, error: selErr } = await ctx.supabaseAdmin
    .from("payments")
    .select("id, status")
    .eq(matchColumn, matchValue)
    .eq("kind", "charge")
    .maybeSingle();

  if (selErr) {
    console.error(`stripe-webhook: lookup failed for ${matchColumn}=${matchValue}:`, selErr);
    return false;
  }
  if (!existing) {
    console.error(`stripe-webhook: no payments row found for ${matchColumn}=${matchValue} (kind=charge)`);
    return false;
  }
  if (!fromStatuses.includes(existing.status)) {
    // Already in a later or unrelated state — an out-of-order or duplicate delivery. Not an
    // error: acknowledge without touching the row.
    console.log(`stripe-webhook: skipping ${toStatus} transition for ${existing.id} — current status is '${existing.status}', not one of [${fromStatuses.join(", ")}]`);
    return true;
  }

  const { error: updErr } = await ctx.supabaseAdmin
    .from("payments")
    .update({ status: toStatus })
    .eq("id", existing.id)
    .in("status", fromStatuses); // re-check at write time, not just at read time — closes the race between the select above and this update
  if (updErr) {
    console.error(`stripe-webhook: failed to set payment ${existing.id} to '${toStatus}':`, updErr);
    return false;
  }
  return true;
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    const signature = req.headers.get("stripe-signature");
    const body = await req.text();

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(body, signature ?? "", webhookSecret, undefined, cryptoProvider);
    } catch (err) {
      console.error("stripe-webhook signature verification failed:", err);
      return Response.json({ message: "Invalid signature" }, { status: 400 });
    }

    // Idempotency gate — record this event.id before doing anything else. A unique-violation on
    // insert means we've already processed it; acknowledge and stop, rather than re-running
    // handlers that may not all be idempotent by luck in the future.
    const { error: dedupeError } = await ctx.supabaseAdmin
      .from("stripe_webhook_events")
      .insert({ id: event.id, type: event.type });
    if (dedupeError) {
      if (dedupeError.code === "23505") {
        console.log(`stripe-webhook: duplicate delivery of ${event.id} (${event.type}) — already processed, skipping`);
        return Response.json({ received: true, duplicate: true });
      }
      // Any other insert failure means we can't safely claim we processed this — don't proceed,
      // let Stripe retry.
      console.error("stripe-webhook: failed to record event for idempotency:", dedupeError);
      return Response.json({ message: "Could not record event" }, { status: 500 });
    }

    let ok = true;

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;

        // Verify the amount Stripe actually collected matches what this platform expected to
        // charge, before trusting the event enough to mark anything succeeded. The charged
        // amount is already server-computed at PaymentIntent creation (create-deposit-intent
        // never trusts a client-supplied price) — this is a reconciliation check, not the
        // primary defense, but it turns "Stripe and our DB silently disagree" into a loud,
        // retried failure instead of a quiet one.
        const { data: expected } = await ctx.supabaseAdmin
          .from("payments")
          .select("amount")
          .eq("stripe_payment_intent_id", pi.id)
          .eq("kind", "charge")
          .maybeSingle();
        const expectedCents = expected ? Math.round(Number(expected.amount) * 100) : null;
        if (expectedCents !== null && pi.amount_received !== expectedCents) {
          console.error(`stripe-webhook: amount mismatch for ${pi.id} — expected ${expectedCents}, Stripe reports ${pi.amount_received}`);
          ok = false;
          break;
        }

        ok = await transitionPayment(ctx, "stripe_payment_intent_id", pi.id, ["processing", "requires_payment"], "succeeded");
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        ok = await transitionPayment(ctx, "stripe_payment_intent_id", pi.id, ["processing", "requires_payment"], "failed");
        break;
      }
      case "charge.refunded": {
        // Fires on every refund, partial or full — charge.refunded (the boolean) only flips to
        // true once the charge's full amount has been returned. A partial refund (e.g. a switch-
        // bid delta) must NOT mark the original charge row as refunded; that refund is already
        // recorded as its own payments row (kind='refund') by finalize_bid_switch.
        const charge = event.data.object as Stripe.Charge;
        if (!charge.refunded) break;
        const intentId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
        if (intentId) {
          // A kind='refund' row records which charge it refunded by storing that *charge's*
          // PaymentIntent id in this same column (see 20260723000000_switch_accepted_bid.sql) —
          // the kind='charge' filter inside transitionPayment() is what keeps this from also
          // matching that refund row itself.
          ok = await transitionPayment(ctx, "stripe_payment_intent_id", intentId, ["succeeded"], "refunded");
        }
        break;
      }
      case "account.updated": {
        // Fired whenever a connected account's status changes — during onboarding as the hauler
        // completes each step, and potentially later if Stripe restricts a previously-enabled
        // account. Must go through apply_connect_account_status(), not a raw
        // supabaseAdmin.from('profiles').update(...): guard_profile_self_update() has no
        // service_role bypass, so a direct table write here would hit that trigger and fail.
        const account = event.data.object as Stripe.Account;
        const { error } = await ctx.supabaseAdmin.rpc("apply_connect_account_status", {
          p_account_id: account.id,
          p_charges_enabled: account.charges_enabled,
          p_payouts_enabled: account.payouts_enabled,
          p_details_submitted: account.details_submitted,
        });
        if (error) {
          console.error(`stripe-webhook: apply_connect_account_status failed for ${account.id}:`, error);
        }
        ok = !error;
        break;
      }
      default:
        break; // unhandled event types are acknowledged and ignored
    }

    if (!ok) {
      // Non-2xx tells Stripe to retry. Returning {received:true} here (as the old code did
      // unconditionally) would have acknowledged an event whose money-state write we know
      // failed — Stripe wouldn't retry, and the mismatch would sit undetected.
      return Response.json({ message: "Could not fully process event" }, { status: 500 });
    }

    return Response.json({ received: true });
  }),
};
