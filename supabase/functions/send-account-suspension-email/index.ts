// send-account-suspension-email
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by dispatch_account_suspension_email()
// from admin_suspend_user only — restoring an account doesn't send anything, same as this app
// sends nothing at anonymization time (see send-account-deletion-email's header comment). Not
// meant to be called by end users — auth is a shared secret header, checked manually below, same
// shape as send-account-deletion-email/send-verification-email.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";
import { timingSafeEqualString } from "../_shared/timingSafeEqual.ts";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";

// profile.name/business_name is user-entered — escape before interpolating.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (!internalKey || !timingSafeEqualString(req.headers.get("apikey") ?? "", internalKey)) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { profileId } = await req.json().catch(() => ({}));
    if (!profileId) {
      return Response.json({ message: "profileId is required" }, { status: 400 });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("email, name, business_name, role")
      .eq("id", profileId)
      .single();
    if (!profile?.email) {
      return Response.json({ skipped: true, reason: "no profile/email" });
    }

    if (!resendApiKey) {
      console.warn(`send-account-suspension-email: RESEND_API_KEY not set, skipping email for ${profileId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const displayName = profile.role === "hauler" ? profile.business_name : profile.name;
    const greeting = displayName ? `, ${escapeHtml(displayName)}` : "";

    const subject = "Your MyTrashBid account has been disabled";
    const html =
      `<h2>Hi${greeting},</h2>` +
      `<p>Your MyTrashBid account has been disabled because it does not comply with our Community Standards.</p>` +
      `<p>If you believe this decision was made in error, please contact our support team at ` +
      `<a href="mailto:support@mytrashbid.com">support@mytrashbid.com</a> for assistance.</p>` +
      `<p>— The MyTrashBid Team</p>`;

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({ from: fromAddress, to: profile.email, subject, html });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-account-suspension-email: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
