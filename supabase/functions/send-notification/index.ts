// send-notification
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by Postgres triggers/RPCs whenever a
// row lands in `notifications`, and directly by other Edge Functions for events they raise
// themselves. Not meant to be called by end users — auth is a shared secret header, checked
// manually below, so `auth: "none"` at the wrapper level plus `verify_jwt = false` in
// supabase/config.toml for this function.
//
// Looks up the recipient's notification_prefs and only emails them if they've opted into
// that event type. Idempotent: re-sending for an already-dispatched notification is a no-op.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";
const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:5173";

// title/body come from user-controlled content (job titles, chat message text). They're
// interpolated into the email HTML below, so escape them — otherwise a user could inject a
// phishing link, tracking pixel, or other markup into the email the other party receives.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const EVENT_SUBJECTS: Record<string, string> = {
  bidReceived: "New bid on your job",
  bidAccepted: "You won a job!",
  newMessage: "New message",
  jobCompleted: "Job completed — leave a review",
  reminderOverdue: "Please confirm job completion",
  jobMarkedDone: "Your hauler marked the job complete",
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== internalKey || !internalKey) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { notificationId } = await req.json().catch(() => ({}));
    if (!notificationId) {
      return Response.json({ message: "notificationId is required" }, { status: 400 });
    }

    const { data: notification, error: notifError } = await ctx.supabaseAdmin
      .from("notifications")
      .select("*")
      .eq("id", notificationId)
      .single();
    if (notifError || !notification) {
      return Response.json({ message: "Notification not found" }, { status: 404 });
    }
    if (notification.email_dispatched) {
      return Response.json({ skipped: true, reason: "already dispatched" });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("email, name, business_name, notification_prefs")
      .eq("id", notification.user_id)
      .single();
    if (!profile?.email) {
      return Response.json({ skipped: true, reason: "recipient has no profile/email" });
    }

    const prefs = profile.notification_prefs as { email?: boolean; events?: Record<string, boolean> };
    if (!prefs?.email || prefs.events?.[notification.event_type] === false) {
      await ctx.supabaseAdmin.from("notifications").update({ email_dispatched: true }).eq("id", notificationId);
      return Response.json({ skipped: true, reason: "recipient opted out" });
    }

    if (!resendApiKey) {
      console.warn(`send-notification: RESEND_API_KEY not set, skipping email for ${notificationId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const link = notification.job_id ? `${appUrl}/jobs/${notification.job_id}` : appUrl;
    const subject = EVENT_SUBJECTS[notification.event_type] ?? notification.title;

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromAddress,
        to: profile.email,
        subject,
        html: `<p>${escapeHtml(notification.title)}</p>` +
          (notification.body ? `<p>${escapeHtml(notification.body)}</p>` : "") +
          `<p><a href="${link}">View on MyTrashBid</a></p>`,
      });

      await ctx.supabaseAdmin.from("notifications").update({ email_dispatched: true }).eq("id", notificationId);
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-notification: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
