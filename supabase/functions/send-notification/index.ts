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
import { timingSafeEqualString } from "../_shared/timingSafeEqual.ts";

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
  bidSwitchedOut: "Customer switched to another hauler",
  cancellationRequested: "Cancellation requested",
  jobCancelled: "Job cancelled",
  jobQuestionAsked: "New question on your job",
  questionAnswered: "Your question was answered",
  bidRevisionProposed: "New price proposed for your job",
  bidRevisionResolved: "Your price revision was resolved",
  scheduleProposed: "New service date proposed",
  scheduleConfirmed: "Service date confirmed",
  coordinationNudge: "Lock in a service date",
  paymentAuthorized: "Your payment method was authorized",
  supportRequested: "Support requested",
  adminJoined: "Support joined your conversation",
  supportResolved: "Support request resolved",
  chatLocked: "Your conversation was locked",
  chatUnlocked: "Your conversation was unlocked",
};

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (!internalKey || !timingSafeEqualString(req.headers.get("apikey") ?? "", internalKey)) {
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

    // Chat is the biggest bombardment risk (a burst of back-and-forth messages would otherwise
    // mean one email per message). Instead of emailing every newMessage notification, cap it to
    // at most one per rolling hour per recipient: if they already got a newMessage email within
    // the last 60 minutes, skip this one — the one that already landed still points them at the
    // conversation. Window resets from the most recent actual send, not a fixed clock boundary.
    if (notification.event_type === "newMessage") {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: recentEmail } = await ctx.supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("user_id", notification.user_id)
        .eq("event_type", "newMessage")
        .eq("email_dispatched", true)
        .gt("created_at", oneHourAgo)
        .neq("id", notification.id)
        .limit(1);
      if (recentEmail && recentEmail.length > 0) {
        await ctx.supabaseAdmin.from("notifications").update({ email_dispatched: true }).eq("id", notificationId);
        return Response.json({ skipped: true, reason: "throttled - recipient already emailed about new messages this hour" });
      }
    }

    if (!resendApiKey) {
      console.warn(`send-notification: RESEND_API_KEY not set, skipping email for ${notificationId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const link = notification.job_id ? `${appUrl}/jobs/${notification.job_id}` : appUrl;
    // Every event type in current use has a fixed entry in EVENT_SUBJECTS, but the fallback still
    // needs some sanitization — a future event type without an EVENT_SUBJECTS entry would
    // otherwise put raw notification.title (user-influenced job/chat content) straight into the
    // subject line. Subject isn't HTML (escapeHtml would just show literal "&lt;" etc. in an
    // inbox), so strip newlines/carriage-returns instead — the one thing that would actually
    // matter for a subject line, closing off header injection if this ever moves off Resend's API.
    const subject = EVENT_SUBJECTS[notification.event_type] ?? notification.title.replace(/[\r\n]+/g, " ");

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
