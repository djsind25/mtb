// stripe-webhook
//
// Receives async payment events from Stripe. Authenticity comes entirely from Stripe's
// signature on the raw body (verified below) — there's no Supabase JWT or API key involved,
// since Stripe itself is the caller. `auth: "none"` here, and this function must have
// `verify_jwt = false` set in supabase/config.toml so the platform doesn't also demand a JWT.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import Stripe from "stripe";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  apiVersion: "2024-06-20",
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const cryptoProvider = Stripe.createSubtleCryptoProvider();

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

    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await ctx.supabaseAdmin.from("payments").update({ status: "succeeded" }).eq("stripe_payment_intent_id", pi.id);
        break;
      }
      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        await ctx.supabaseAdmin.from("payments").update({ status: "failed" }).eq("stripe_payment_intent_id", pi.id);
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
          await ctx.supabaseAdmin.from("payments").update({ status: "refunded" }).eq("stripe_payment_intent_id", intentId);
        }
        break;
      }
      default:
        break; // unhandled event types are acknowledged and ignored
    }

    return Response.json({ received: true });
  }),
};
