// send-verification-email
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by the handle_new_user trigger right
// after a profile row is created. Not meant to be called by end users — auth is a shared secret
// header, checked manually below, so `auth: "none"` at the wrapper level plus `verify_jwt = false`
// in supabase/config.toml for this function.
//
// This is deliberately separate from Supabase Auth's own confirmation email: signup auto-confirms
// (enable_confirmations = false) so customers/haulers are logged in immediately, but a job post
// stays in `pending_verification` status (invisible to haulers) until this custom link is clicked
// — see the verify_email() RPC, which flips any pending posts to open once the token matches.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";
const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:4173";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== internalKey || !internalKey) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { profileId } = await req.json().catch(() => ({}));
    if (!profileId) {
      return Response.json({ message: "profileId is required" }, { status: 400 });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("email, name, email_verify_token, email_verified_at")
      .eq("id", profileId)
      .single();
    if (!profile?.email || !profile.email_verify_token) {
      return Response.json({ skipped: true, reason: "no profile/email/token" });
    }
    if (profile.email_verified_at) {
      return Response.json({ skipped: true, reason: "already verified" });
    }

    if (!resendApiKey) {
      console.warn(`send-verification-email: RESEND_API_KEY not set, skipping email for ${profileId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const link = `${siteUrl}/?verify=${profile.email_verify_token}`;

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromAddress,
        to: profile.email,
        subject: "Verify your email to activate your MyTrashBid post",
        html: `<h2>Thanks for signing up${profile.name ? `, ${profile.name}` : ""}.</h2>` +
          `<p>You're already logged in — but any job you post won't be visible to haulers until you verify your email.</p>` +
          `<p><a href="${link}">Verify my email</a></p>` +
          `<p>If you have a post pending, it'll go live automatically the moment you verify.</p>`,
      });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-verification-email: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
