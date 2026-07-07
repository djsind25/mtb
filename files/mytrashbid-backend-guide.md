# MyTrashBid — Backend Implementation Guide
### Stripe Payments & Real-Time Notifications (Email + SMS)

This is the practical wiring plan for the two pieces that **cannot** live inside the front-end app: charging money (Stripe) and sending email/SMS. Both require a server you control, because they depend on secret API keys that must never ship to a browser. The current prototype tracks deposits, commission, and notification *intent* as data; this guide explains how to make them real.

---

## 0. Why these need a backend (the one-paragraph version)

A React app runs entirely in the user's browser, where any "secret" key can be read by anyone who opens dev tools. Stripe's secret key can create charges and issue refunds; an email/SMS key can send on your behalf and rack up a bill. So all three features route through a small server layer that holds the keys and exposes only safe, purpose-built endpoints to the app. You do **not** need a big custom backend — a managed option (Supabase, Firebase, or a few serverless functions) is enough to launch.

**Recommended starting stack for a solo/small launch:**
- **Supabase** (Postgres database + Auth + Edge Functions) — replaces the prototype's `window.storage`, gives you real accounts, and hosts your secret-key server code in Edge Functions.
- **Stripe Connect** for marketplace payments.
- **Resend** (email) and **Twilio** (SMS) for notifications.

You can swap any piece (Firebase instead of Supabase, SendGrid instead of Resend, etc.) — the architecture is the same.

---

## 1. Stripe — the marketplace payment model

### 1.1 Which Stripe product you need

MyTrashBid is a **two-sided marketplace**: customers pay, haulers receive money, and you keep 10%. That is exactly what **Stripe Connect** is built for. Plain Stripe Checkout (one merchant) is not enough because you need to pay out a third party (the hauler) and take a cut.

Use **Stripe Connect with `destination` charges** (or `transfer_data`), which lets you:
1. Charge the customer the full bid amount.
2. Automatically route the hauler's share to their connected account.
3. Keep your 10% as an `application_fee_amount`.

### 1.2 Hauler onboarding (one-time, per hauler)

Before a hauler can be paid, they connect a Stripe account. Stripe hosts the entire onboarding flow (bank details, identity, tax) so you never touch sensitive banking data.

```
Hauler clicks "Set up payouts"
  → your server calls stripe.accounts.create({ type: 'express' })
  → your server calls stripe.accountLinks.create({ ... }) to get a onboarding URL
  → redirect hauler to that URL (Stripe-hosted)
  → Stripe redirects back to your "return_url" when done
  → store the resulting `account.id` (acct_xxx) on the hauler's record
```

Store `stripe_account_id` on the hauler row. A hauler without a completed Stripe account can still bid, but cannot have a bid *accepted* until payouts are set up (or you hold their first payout until they finish — your call).

### 1.3 The deposit-on-acceptance flow

This matches what the prototype already models (deposit collected when the customer accepts a bid):

```
Customer taps "Accept bid" ($195 example)
  → app calls YOUR server endpoint POST /accept-bid { jobId, bidId }
  → server recomputes the amount from the DB (never trust the client's number)
  → server creates a PaymentIntent:

     stripe.paymentIntents.create({
       amount: 19500,                       // cents
       currency: 'usd',
       application_fee_amount: 1950,         // your 10%
       transfer_data: { destination: haulerStripeAccountId },
       capture_method: 'manual',            // authorize now, capture on completion
       metadata: { jobId, bidId, customerId, haulerId }
     })

  → return the client_secret to the app
  → app confirms payment with Stripe.js (card entry happens in Stripe's UI, not yours)
```

**Why `capture_method: 'manual'`** — this authorizes (holds) the funds when the customer accepts, but doesn't actually move the money until you *capture*. That mirrors your "deposit held → finalized on completion" rule. When the hauler confirms the job complete (the 30-day window in the app), your server calls `stripe.paymentIntents.capture(id)`, which releases the hauler's payout and your 10% fee in one step.

If you'd rather collect a *partial* deposit (say 10%) up front and the rest on completion, you run two PaymentIntents instead — but manual capture of the full amount is simpler and is the cleaner v1.

### 1.4 The completion → capture → review flow

```
Hauler taps "Confirm job complete"  (the existing 30-day window)
  → server POST /complete-job { jobId }
  → server calls stripe.paymentIntents.capture(paymentIntentId)
  → Stripe moves hauler payout + your application fee
  → server marks job completed, commissionStatus = 'earned'
  → unlock the review form for both sides (already built in the app)
```

### 1.5 Refunds / cancellations

If a customer cancels before completion (job not captured yet), call `stripe.paymentIntents.cancel(id)` to release the authorization — no money ever moved. If you've already captured, use `stripe.refunds.create({ payment_intent: id })`. Decide your cancellation policy (full refund within X hours, etc.) and enforce it server-side.

### 1.6 Webhooks (do not skip these)

Stripe tells your server about events asynchronously. Set up a webhook endpoint and verify the signature with your webhook secret. Minimum events to handle:

| Event | What you do |
|---|---|
| `payment_intent.succeeded` | Mark deposit captured/confirmed |
| `payment_intent.payment_failed` | Notify customer, keep job open |
| `account.updated` | Track when a hauler finishes Stripe onboarding |
| `charge.refunded` | Update job + notify both parties |

```js
// pseudo — Supabase Edge Function / Express handler
const sig = req.headers['stripe-signature'];
const event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
switch (event.type) {
  case 'payment_intent.succeeded': /* ... */ break;
  // ...
}
```

### 1.7 Keys & env vars (server-side only)

```
STRIPE_SECRET_KEY=sk_live_xxx        # NEVER in the React app
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PUBLISHABLE_KEY=pk_live_xxx   # this one CAN go in the app (it's public)
```

The publishable key (`pk_`) is safe in the front end — it can only *start* a payment, not capture or refund. The secret key (`sk_`) stays on the server forever.

---

## 2. Notifications — Email + SMS

The app already has the right *triggers* (bid placed, bid accepted, job completed, flagged message, overdue completion). Each trigger should call a server endpoint that sends the message. Browsers can't send email or SMS, so this is server work.

### 2.1 Pick providers

- **Email: Resend** (simple, modern, generous free tier) — or SendGrid / AWS SES.
- **SMS: Twilio** (industry standard) — or Telnyx / AWS SNS.

Both need an account, a verified sender (a domain for email, a phone number for SMS), and a server-side API key.

### 2.2 Notification preferences (build this in the app)

Add to each user's profile so they choose how they're reached. This part *can* live in the front-end UI; only the actual sending is server-side.

```
notificationPrefs: {
  email: true,
  sms: false,
  events: {
    bidReceived: true,      // customer: a hauler bid on your job
    bidAccepted: true,      // hauler: you won a job
    newMessage: true,       // both: chat message
    jobCompleted: true,     // both: completion + review prompt
    reminderOverdue: true   // hauler: 30-day completion nudge
  }
}
```

Collect the phone number at signup (with consent language — see 2.5) if SMS is enabled.

### 2.3 The send flow

```
Something happens (e.g. hauler submits a bid)
  → app/server writes the bid to the DB
  → server looks up the customer's notificationPrefs
  → if email enabled: call Resend
  → if sms enabled: call Twilio
```

```js
// Email via Resend (server-side)
await resend.emails.send({
  from: 'MyTrashBid <bids@mytrashbid.com>',
  to: customer.email,
  subject: 'New bid on your job 🚛',
  html: `<p>${hauler.businessName} just bid $${bid.amount} on "${job.title}".</p>
         <p><a href="https://mytrashbid.com/jobs/${job.id}">View the bid</a></p>`
});

// SMS via Twilio (server-side)
await twilio.messages.create({
  from: '+1XXXXXXXXXX',                       // your Twilio number
  to: customer.phone,
  body: `MyTrashBid: ${hauler.businessName} bid $${bid.amount} on "${job.title}". View: mytrashbid.com/j/${job.id}`
});
```

### 2.4 "Real-time" in-app notifications

For the live in-app experience (a badge/toast appearing without refresh), use **Supabase Realtime** (Postgres change subscriptions) or Firebase's realtime listeners. The app subscribes to the user's `notifications` table and renders new rows instantly. This replaces the current "refresh to see new bids" limitation.

```js
// app subscribes (front-end, safe — no secret keys)
supabase.channel('notifications')
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
      payload => showToast(payload.new))
  .subscribe();
```

So you end up with three layers: instant in-app (Realtime), plus email and/or SMS for when they're not looking at the app.

### 2.5 Compliance you must not skip (SMS especially)

- **SMS consent (TCPA, US law):** you must get explicit opt-in before texting, include "Reply STOP to unsubscribe" on messages, and honor STOP immediately. Twilio has tooling for this but the legal responsibility is yours. Add a checkbox at signup: "Text me bid updates (msg & data rates may apply)."
- **A2P 10DLC registration:** US carriers require you to register your business and SMS campaign before sending app-to-person texts at volume. Budget a few days for this with Twilio.
- **Email (CAN-SPAM):** include a physical mailing address and an unsubscribe link in non-transactional emails. Transactional ones (bid alerts) are lower-risk but still keep an unsubscribe path for marketing.
- **Quiet hours:** consider not sending SMS late at night; some states regulate this.

### 2.6 Env vars (server-side only)

```
RESEND_API_KEY=re_xxx
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
```

---

## 3. Distance / radius matching (already built in the app — production upgrade)

The app now filters jobs to a **50-mile radius** of the hauler's service ZIP using an embedded ZIP→lat/long table and the haversine formula. For production you only need to upgrade the data source:

- **Option A (cheap, offline):** import a full US ZIP centroid dataset (free from the US Census / SimpleMaps) into your DB. Same haversine math, every ZIP covered.
- **Option B (most accurate):** geocode each address with Google Maps or Mapbox at posting time, store the real lat/long, and compute distance from the hauler's geocoded service area. Costs per lookup but handles exact addresses, not just ZIP centroids.

Either way, do the distance filter **server-side** in the query (e.g. Postgres `earthdistance`/PostGIS `ST_DWithin`) so a hauler never even receives out-of-range jobs. The 50-mile constant is already isolated in the code as `MAX_RADIUS_MI`.

---

## 4. Suggested build order

1. **Stand up Supabase** — migrate accounts/jobs/bids/chats off `window.storage` into real Postgres tables with row-level security. (This is the foundation everything else needs.)
2. **Stripe Connect onboarding** for haulers (payouts setup).
3. **Deposit-on-accept** with manual-capture PaymentIntents + the completion→capture flow.
4. **Stripe webhooks** for reliability.
5. **Notification preferences UI** in the app + the `notifications` table.
6. **Resend email** for the core events.
7. **Supabase Realtime** for instant in-app notifications.
8. **Twilio SMS** last — because of the A2P 10DLC registration lead time, start that paperwork early even if you wire it up last.
9. **Production ZIP/geo data** to replace the embedded table.

---

## 5. Cost expectations (rough, US, at launch volume)

| Service | Typical cost |
|---|---|
| Supabase | Free tier to start; ~$25/mo Pro when you grow |
| Stripe | 2.9% + 30¢ per charge, plus Connect fees (~0.25%+); you pass card fees into pricing or absorb from your 10% |
| Resend | Free up to ~3k emails/mo, then ~$20/mo |
| Twilio | ~$1/mo per number + ~$0.0079 per SMS + one-time A2P registration |

The Stripe card fee is the one to plan around: on a $195 job your 10% is $19.50, but Stripe takes ~$6 in card fees on the full $195. Decide whether the hauler, the customer, or your margin absorbs that.

---

*This guide pairs with the working prototype. The prototype proves the product flows (post → bid → accept → chat → complete → review, now with 50-mile radius matching). This document is the bridge from that prototype to a real, money-moving, notifying production app.*
