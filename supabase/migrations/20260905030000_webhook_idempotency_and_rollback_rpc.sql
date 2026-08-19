-- Ports audit findings M-1 (webhook idempotency) and M-3 (atomic booking rollback) from the
-- MyPartyBid security audit (2026-08-19). Both are payments/chats/jobs/notifications logic —
-- fully generic, no hauler/vendor-specific columns involved — so this ports unchanged. The
-- stripe-webhook and create-deposit-intent Edge Function updates that use these land in the same
-- deploy as this migration.

-- ---------------------------------------------------------------------------------------------
-- M-1 · Stripe webhook has no idempotency tracking
--
-- Stripe delivers webhooks at-least-once, so the same event.id can arrive more than once (a
-- retry after a slow 200, a dashboard-triggered resend, a network blip). The handler's writes
-- were all unconditional, so processing the same event twice was harmless by luck (both are
-- idempotent .update()s) — but there was no record of what had already been processed, which is
-- what actually matters for auditability and for correctly rejecting genuinely duplicate/replayed
-- events.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "public"."stripe_webhook_events" (
    "id" "text" NOT NULL,
    "type" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "stripe_webhook_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."stripe_webhook_events" OWNER TO "postgres";
ALTER TABLE "public"."stripe_webhook_events" ENABLE ROW LEVEL SECURITY;

-- No policies, and no grant to anon/authenticated — this table has no legitimate user-facing
-- read/write path at all. RLS bypass (which service_role gets automatically) only skips *row*-
-- level policy checks; it does not imply *table*-level privileges, which still need an explicit
-- GRANT the same as any other role — every other table in this schema gets one. Missing this
-- line was caught on MyPartyBid by actually exercising the webhook locally: it failed with 42501
-- permission denied, not a silent no-op.
GRANT ALL ON TABLE "public"."stripe_webhook_events" TO "service_role";

-- ---------------------------------------------------------------------------------------------
-- M-3 · Booking rollback in create-deposit-intent is non-atomic
--
-- On a Stripe failure the Edge Function unwound the booking with four separate, unchecked
-- supabaseAdmin writes. A crash or partial failure mid-unwind could leave a job stuck `booked`
-- with no PaymentIntent and no way for the customer to retry (accept_bid refuses: "Job is not
-- open"). Moving the whole unwind into one PL/pgSQL function body makes it atomic — Postgres
-- either applies all four statements or none of them.
--
-- service_role-only by both grant and an internal check (defense in depth) — this reverses a
-- booking outright and must never be reachable via PostgREST from a user session.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."rollback_bid_acceptance"("p_job_id" "uuid", "p_chat_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Not permitted.';
  end if;

  delete from notifications where chat_id = p_chat_id;
  delete from payments where job_id = p_job_id and stripe_payment_intent_id is null;
  delete from chats where id = p_chat_id;

  perform set_config('app.bypass_job_guard', 'true', true);
  update jobs set status = 'open', accepted_bid_id = null, accepted_at = null, complete_by = null
  where id = p_job_id;
end;
$$;

ALTER FUNCTION "public"."rollback_bid_acceptance"("p_job_id" "uuid", "p_chat_id" "uuid") OWNER TO "postgres";
REVOKE ALL ON FUNCTION "public"."rollback_bid_acceptance"("p_job_id" "uuid", "p_chat_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rollback_bid_acceptance"("p_job_id" "uuid", "p_chat_id" "uuid") TO "service_role";
