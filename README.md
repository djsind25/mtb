# MyTrashBid

A two-sided marketplace for junk removal / dumpster rental: customers post a job, vetted
local haulers bid, the customer accepts a bid and pays a 10% deposit, the rest is settled
hauler-direct at completion. Launch market: Will County, IL.

This repo contains both the **production backend** (Supabase: Postgres + Auth + Storage +
Realtime + Edge Functions) and the **production front end** (`web/`, Vite + React), ported from
the working prototype in [`files/junk-bids-platform-full.jsx`](files/junk-bids-platform-full.jsx)
into real, row-level-secured database tables and a Supabase-backed SPA — see
[`files/mytrashbid-backend-guide.md`](files/mytrashbid-backend-guide.md) and
[`files/MyTrashBid-Scope-of-Work.docx`](files/MyTrashBid-Scope-of-Work.docx) for the full spec.

Per the Scope of Work, v1 is **deposit-only**: plain Stripe PaymentIntents, not Stripe Connect.
The full bid amount is never charged or held by the platform; only the 10% deposit is.

## What's here

```
supabase/
  migrations/           schema, RLS policies, RPC functions, storage bucket + ZIP seed data
  functions/
    create-deposit-intent/  accept a bid -> books the job -> creates a Stripe deposit PaymentIntent
    stripe-webhook/         payment_intent.succeeded / .payment_failed / charge.refunded
    send-notification/      Resend email dispatch, gated by each user's notification_prefs
  config.toml
scripts/
  smoke-test.mjs        end-to-end sanity check (signup -> job -> bid -> notification -> accept)
web/                    Vite + React SPA — customer/hauler/admin app, wired to the backend above
  src/
    auth/               landing, signup/login (real Supabase Auth, not the prototype's demo passcode)
    jobs/               post/browse/bid/accept (Stripe Elements)/renew/confirm-complete
    chat/               chat list + thread (Realtime), reviews
    admin/              admin dashboard (users, jobs & bids, flagged messages, overdue)
    ui/, theme.js        shared primitives + the MyTrashBid brand tokens, ported verbatim
```

## Data model

`profiles` (1:1 with `auth.users`, role = customer/hauler/admin) · `jobs` · `bids` · `chats` ·
`messages` · `reviews` · `payments` · `notifications` · `zip_geo` (ZIP → lat/lng centroids) ·
`app_config` (admin-tunable constants: `live_window_days`=14, `completion_window_days`=30,
`max_radius_mi`=50, `commission_rate`=0.10).

All business rules are enforced **server-side**, never trusted from the client:
- Bid/job expiry windows are set by triggers using `now()`, not a client-supplied timestamp.
- The 50-mile radius filter runs inside `list_open_jobs_for_hauler()` (SECURITY DEFINER) — a
  hauler querying the `jobs` table directly only ever sees jobs they've already bid on or won;
  browsing *open* jobs only works through that function, so the radius check can't be bypassed.
- `accept_bid()` recomputes the deposit/commission from the DB bid amount before anything is
  charged — the `create-deposit-intent` Edge Function calls this before talking to Stripe.

## Local development

Prereqs: Docker (running), Node.js. The Supabase CLI is invoked via `npx`, no global install
needed.

```bash
npx supabase start                                    # boots Postgres, Auth, Storage, Realtime, Studio
npx supabase functions serve --env-file supabase/.env  # serves the 3 Edge Functions, in a second terminal
node scripts/smoke-test.mjs                            # exercises the full flow
```

`supabase start` prints local URLs/keys, including **Studio** (a Postgres/Auth GUI) at
`http://127.0.0.1:54323`.

If you change the schema, edit a file under `supabase/migrations/` (or add a new one with
`npx supabase migration new <name>`) and run `npx supabase db reset` to reapply everything
from scratch.

### `supabase/.env` (local secrets — gitignored)

Copy `supabase/.env.example` and fill in test keys as you get them. Two entries matter even
before you have real Stripe/Resend accounts:

- **`INTERNAL_DISPATCH_KEY`** — Postgres calls `send-notification` directly (via `pg_net`, see
  below) using a shared secret. It must exactly match the `internal_dispatch_key` row in
  `app_config`, which is regenerated randomly on every `db reset`:
  ```sql
  select value from app_config where key = 'internal_dispatch_key';
  ```
  Copy that value into `supabase/.env`, then restart `functions serve` so it picks up the change.
- **`STRIPE_SECRET_KEY`** / **`RESEND_API_KEY`** — until these are real, `create-deposit-intent`
  will fail at the Stripe call (and cleanly roll back the booking — this is intentional and
  covered by the smoke test) and `send-notification` will skip sending email and say why. Both
  failure modes are handled gracefully; nothing crashes without real keys.

### How email notifications actually get sent

Five events email a user (per the Scope of Work): new bid, bid accepted, new chat message, job
completed, 30-day-overdue reminder. Four of those originate from a plain Postgres trigger
(`bids`, `messages`) or a scheduled job (`pg_cron`, overdue reminders) — Postgres can't make an
HTTP call on its own, so `dispatch_notification_email()` uses the `pg_net` extension to POST to
the `send-notification` function, fire-and-forget, right after every `notifications` insert.
The fifth (bid accepted) is raised directly by the `create-deposit-intent` function.

**Local-dev networking note:** from *inside* the Postgres container, `127.0.0.1` means the
container itself, not your machine — so `functions_base_url` in `app_config` points at Kong's
Docker network alias (`http://kong:8000/functions/v1`), not `127.0.0.1:54321`. Only change this
if you know what you're doing locally; it's set correctly by the seed migration already.

## Deploying

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push                                  # applies migrations to the real project
npx supabase secrets set --env-file supabase/.env      # after replacing placeholders with real keys
npx supabase functions deploy create-deposit-intent
npx supabase functions deploy stripe-webhook
npx supabase functions deploy send-notification
```

Then, one-time:
1. In the Stripe dashboard, add a webhook endpoint pointing at
   `https://<ref>.supabase.co/functions/v1/stripe-webhook` for `payment_intent.succeeded`,
   `payment_intent.payment_failed`, and `charge.refunded`; put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.
2. Verify a sending domain in Resend and put a real `RESEND_FROM_EMAIL` address on it.
3. Update `app_config.functions_base_url` to `https://<ref>.supabase.co/functions/v1` (it
   defaults to the local Docker address above).
4. **Bootstrap the admin account** — there's no public signup path for `role = 'admin'`
   (blocked deliberately, see the `profiles_insert_own` policy). Create the user once via the
   Auth Admin API or Studio, then insert their `profiles` row with `role = 'admin'` using the
   service role key, which bypasses that restriction.
5. To cover more than the seeded Will County ZIPs, bulk-import a full ZIP centroid dataset
   (US Census gazetteer or SimpleMaps) into the `zip_geo` table — no code changes needed.

### Front end (`web/`)

```bash
cd web
npm install
cp .env.example .env    # already points at the local Supabase URL/anon key by default
npm run dev             # http://localhost:5173
```

Needs the backend running (`supabase start` + `functions serve`, above) and at least one
account to sign in with — sign up as a customer and a hauler from the landing page. There's no
public admin signup; bootstrap that account the same way as in "Deploying" below, using the
local service role key from `supabase start`'s printed output.

**Realtime gotcha (cost me a while to track down, worth knowing):** a single channel with two
`postgres_changes` bindings (e.g. one for `messages` INSERT and one for `chats` UPDATE) silently
drops events for *both* bindings on this Realtime version — no error, the channel shows
`SUBSCRIBED`, it just never fires. `ChatThread.jsx` works around this by opening one channel per
table. If you add more live-subscribed tables, keep that pattern (one channel per table, not one
channel with multiple `.on(...)` calls).

## What's deliberately out of scope for v1

Per the Scope of Work: Stripe Connect / marketplace payouts / the `'full'` payment mode
(the `payment_mode` column and pricing seam already exist for this — just not wired to charge
or hold the full amount), native mobile apps, SMS (Twilio — deferred; `notification_prefs.sms`
is already modeled so it's a pure addition later, no rearchitecture), multi-region expansion,
hauler subscriptions/featured placement.

## Verified locally

Both the backend (via `scripts/smoke-test.mjs` and direct RPC/psql checks) and the front end
(via a real browser session against the local stack) have been exercised end to end: signup for
both roles, job posting with photo upload, radius-filtered browsing, bidding, accept-bid through
`create-deposit-intent` (including its rollback path — Stripe naturally fails locally without
real keys), realtime chat with server-side message flagging (first offense + repeat escalation),
job completion, two-sided reviews, and every admin dashboard tab. The one thing that *can't* be
verified without real Stripe test keys is an actual successful deposit charge — that failure
mode is exercised and handled (see above), but confirming a real payment needs your own keys.

## Next steps

- Add real Stripe/Resend test keys to `supabase/.env` and confirm a full deposit payment.
- Deploy (see "Deploying" above) and re-test against the hosted project.
- Bulk-import a full ZIP centroid dataset if launching outside Will County.
