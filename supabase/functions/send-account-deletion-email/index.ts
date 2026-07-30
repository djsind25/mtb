// send-account-deletion-email
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by dispatch_account_deletion_email()
// from request_own_account_deletion / admin_start_deletion (kind: "requested") and
// cancel_own_pending_deletion / admin_cancel_pending_deletion (kind: "cancelled"). Not meant to be
// called by end users — auth is a shared secret header, checked manually below, same shape as
// send-verification-email.
//
// "requested" covers both the "deletion confirmation" and "deletion scheduled" emails named in
// the spec in one send, since in this app's actual flow the request and the 30-day scheduling
// happen atomically in the same RPC call — sending two separate emails for the same instant would
// just be noise. No email is sent at anonymization time (nothing left to reliably email by then).

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";

// profile.name/business_name/deletion_reason are user-entered — escape before interpolating.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== internalKey || !internalKey) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { profileId, kind } = await req.json().catch(() => ({}));
    if (!profileId || (kind !== "requested" && kind !== "cancelled")) {
      return Response.json({ message: "profileId and a valid kind are required" }, { status: 400 });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("email, name, business_name, role, deletion_scheduled_for")
      .eq("id", profileId)
      .single();
    if (!profile?.email) {
      return Response.json({ skipped: true, reason: "no profile/email" });
    }

    if (!resendApiKey) {
      console.warn(`send-account-deletion-email: RESEND_API_KEY not set, skipping email for ${profileId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const displayName = profile.role === "hauler" ? profile.business_name : profile.name;
    const greeting = displayName ? `, ${escapeHtml(displayName)}` : "";

    const subject = kind === "requested"
      ? "Your MyTrashBid account is scheduled for deletion"
      : "Your account deletion request was cancelled";

    const html = kind === "requested"
      ? `<h2>Hi${greeting},</h2>` +
        `<p>We've received your request to delete your MyTrashBid account.</p>` +
        `<p>Your account is scheduled to be permanently anonymized on ` +
        `<strong>${profile.deletion_scheduled_for ? new Date(profile.deletion_scheduled_for).toLocaleDateString() : "the scheduled date"}</strong>.</p>` +
        `<p>Until then, you can log back in at any time to cancel this request and keep your account active.</p>`
      : `<h2>Hi${greeting},</h2>` +
        `<p>Your MyTrashBid account deletion request has been cancelled — your account is back to normal.</p>` +
        `<p>If you didn't request this, please contact support right away.</p>`;

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({ from: fromAddress, to: profile.email, subject, html });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-account-deletion-email: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
