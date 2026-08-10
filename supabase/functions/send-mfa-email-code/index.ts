// send-mfa-email-code
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by start_email_mfa_enrollment() whenever
// a hauler/customer starts enrolling the email-code 2FA method. Not meant to be called by end
// users — auth is a shared secret header, checked manually below, so `auth: "none"` at the wrapper
// level plus `verify_jwt = false` in supabase/config.toml for this function.
//
// Deliberately NOT routed through the notifications table / send-notification — a security code
// must always send regardless of the recipient's notification_prefs. The plaintext code only ever
// exists here and in the RPC's local variable; the DB only ever stores its bcrypt hash.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";
import { timingSafeEqualString } from "../_shared/timingSafeEqual.ts";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (!internalKey || !timingSafeEqualString(req.headers.get("apikey") ?? "", internalKey)) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { userId, code } = await req.json().catch(() => ({}));
    if (!userId || !code) {
      return Response.json({ message: "userId and code are required" }, { status: 400 });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("email, name")
      .eq("id", userId)
      .single();
    if (!profile?.email) {
      return Response.json({ skipped: true, reason: "recipient has no profile/email" });
    }

    if (!resendApiKey) {
      console.warn(`send-mfa-email-code: RESEND_API_KEY not set, skipping email for ${userId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromAddress,
        to: profile.email,
        subject: `Your MyTrashBid security code: ${code}`,
        html: `<p>Your two-factor authentication code is:</p>` +
          `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
          `<p>This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
      });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-mfa-email-code: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
