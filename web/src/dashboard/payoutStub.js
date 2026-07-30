// STUB ONLY — never wired into any RPC or UI button in this pass. This app has no Stripe Connect
// / hauler payout-account mechanism today: deposit-mode haulers are paid off-platform, and
// full-payment-mode funds are held/released by the platform via plain Stripe PaymentIntents
// (create-deposit-intent / stripe-webhook), not a Connect account. So there is nothing for this
// function to actually disconnect yet — it exists only to mark the seam for when a real payout
// mechanism is built.
//
// TODO (when real payouts exist): before doing anything for real here, call
// check_account_deletion_blockers(haulerId) and refuse to proceed if a 'pending_payment' (aliased
// to 'pending_payout' today, per 20260815000000_account_deletion_and_suspension.sql) blocker is
// still present — never assume local anonymization alone means it's safe to close out an external
// payout account with money still owed or in flight.
export async function disconnectHaulerPayoutAccount(_haulerId) {
  return { skipped: true, reason: "no payout-account mechanism exists in this app yet" };
}
