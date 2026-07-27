// send-sms-notification
//
// Two modes, both internal-only (shared-secret apikey header, same as send-notification):
//   { notificationId } — one immediate text for a single notifications row (bidAccepted,
//     jobBooked, newMessage, adminMessage).
//   { digest: true } — cron-fired hourly; gathers every undispatched newJobNearby row, groups by
//     hauler, and sends at most one combined text per hauler instead of one per job.
//
// Wired for AWS SNS (@aws-sdk/client-sns, same npm-import pattern as Stripe/Resend elsewhere in
// this repo) — set AWS_SNS_ACCESS_KEY_ID / AWS_SNS_SECRET_ACCESS_KEY / AWS_SNS_REGION as secrets
// to go live. Without them this logs a warning and skips sending, same graceful-degrade pattern
// as RESEND_API_KEY in send-notification — nothing breaks, texts just don't go out until the
// provider is configured.
//
// Two AWS-specific things to know before flipping this on for real (see the
// sms-provider-decision memory): (1) new AWS accounts start in the SNS SMS *sandbox* — Publish
// only reaches phone numbers you've manually verified in the SNS console until you request
// production access; (2) US A2P 10DLC registration is still required for real volume regardless
// of provider — switching from Twilio to SNS consolidates billing/IAM, it doesn't remove that
// compliance step.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const snsAccessKeyId = Deno.env.get("AWS_SNS_ACCESS_KEY_ID");
const snsSecretAccessKey = Deno.env.get("AWS_SNS_SECRET_ACCESS_KEY");
const snsRegion = Deno.env.get("AWS_SNS_REGION") ?? "us-east-1";
const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:5173";

const snsClient = snsAccessKeyId && snsSecretAccessKey
  ? new SNSClient({
      region: snsRegion,
      credentials: { accessKeyId: snsAccessKeyId, secretAccessKey: snsSecretAccessKey },
    })
  : null;

// Phone numbers are entered free-text at signup (e.g. "(555) 867-5309") — SNS's Publish call
// requires E.164. Normalizes US 10-digit numbers; returns null for anything else so a malformed
// number fails loud (logged) instead of erroring inside the SNS client.
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+")) return raw;
  return null;
}

const STOP_FOOTER = " Reply STOP to unsubscribe.";

const EVENT_TEMPLATES: Record<string, (title: string, body: string | null, link: string) => string> = {
  bidAccepted: (title, _body, link) => `You won a job! "${title}" is booked. ${link}`,
  jobBooked: (title, _body, link) => `Your job "${title}" is booked! ${link}`,
  newMessage: (_title, body, link) => `New MyTrashBid message: ${body ?? ""} ${link}`,
  adminMessage: (_title, body, link) => `MyTrashBid support: ${body ?? ""} ${link}`,
  jobMarkedDone: (title, _body, link) => `Your hauler marked "${title}" complete — review the photos & acknowledge. ${link}`,
  cancellationRequested: (title, _body, link) => `A cancellation was requested for "${title}" — it's under review by MyTrashBid. ${link}`,
  jobCancelled: (title, _body, link) => `"${title}" was cancelled by MyTrashBid. ${link}`,
  bidSwitchedOut: (title, body, link) => `${title}${body ? `: "${body}"` : ""}. ${link}`,
  jobQuestionAsked: (title, _body, link) => `${title} ${link}`,
  questionAnswered: (title, _body, link) => `${title} ${link}`,
  bidRevisionProposed: (title, body, link) => `${title}${body ? `: ${body}` : ""}. ${link}`,
  bidRevisionResolved: (title, body, link) => `${title}${body ? `: ${body}` : ""}. ${link}`,
  scheduleProposed: (title, body, link) => `${title}${body ? `: ${body}` : ""}. ${link}`,
  scheduleConfirmed: (title, body, link) => `${title}${body ? `: ${body}` : ""}. ${link}`,
  coordinationNudge: (title, _body, link) => `${title} — pick a date to keep this job moving. ${link}`,
  paymentAuthorized: (title, body, link) => `${title}${body ? `: ${body}` : ""}. ${link}`,
};

async function sendSms(to: string, body: string): Promise<boolean> {
  if (!snsClient) {
    console.warn("send-sms-notification: AWS SNS credentials not configured, skipping send");
    return false;
  }
  const phoneNumber = toE164(to);
  if (!phoneNumber) {
    console.error("send-sms-notification: could not normalize phone number to E.164:", to);
    return false;
  }
  try {
    await snsClient.send(new PublishCommand({
      PhoneNumber: phoneNumber,
      Message: body + STOP_FOOTER,
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
      },
    }));
    return true;
  } catch (err) {
    console.error("send-sms-notification: SNS Publish failed:", err);
    return false;
  }
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== internalKey || !internalKey) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { notificationId, digest } = await req.json().catch(() => ({}));

    if (digest) {
      const { data: pending, error } = await ctx.supabaseAdmin
        .from("notifications")
        .select("id, user_id, title, zip:body")
        .eq("event_type", "newJobNearby")
        .eq("sms_dispatched", false);
      if (error) return Response.json({ message: error.message }, { status: 500 });
      if (!pending || pending.length === 0) return Response.json({ sent: 0 });

      const byUser = new Map<string, typeof pending>();
      for (const row of pending) {
        if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
        byUser.get(row.user_id)!.push(row);
      }

      let sentCount = 0;
      for (const [userId, rows] of byUser) {
        const ids = rows.map((r) => r.id);
        const { data: profile } = await ctx.supabaseAdmin
          .from("profiles")
          .select("phone, sms_consent, notification_prefs")
          .eq("id", userId)
          .single();
        const prefs = profile?.notification_prefs as { smsEvents?: Record<string, boolean> } | undefined;
        const optedIn = profile?.sms_consent && profile.phone && prefs?.smsEvents?.newJobNearby !== false;
        if (optedIn) {
          const titles = rows.slice(0, 3).map((r) => r.title).join(", ");
          const extra = rows.length > 3 ? ` and ${rows.length - 3} more` : "";
          const text = `${rows.length} new job${rows.length === 1 ? "" : "s"} near you on MyTrashBid: ${titles}${extra}. Browse: ${appUrl}`;
          if (await sendSms(profile!.phone, text)) sentCount++;
        }
        await ctx.supabaseAdmin.from("notifications").update({ sms_dispatched: true }).in("id", ids);
      }
      return Response.json({ sent: sentCount, haulers: byUser.size });
    }

    if (!notificationId) {
      return Response.json({ message: "notificationId or digest is required" }, { status: 400 });
    }

    const { data: notification, error: notifError } = await ctx.supabaseAdmin
      .from("notifications")
      .select("*")
      .eq("id", notificationId)
      .single();
    if (notifError || !notification) {
      return Response.json({ message: "Notification not found" }, { status: 404 });
    }
    if (notification.sms_dispatched) {
      return Response.json({ skipped: true, reason: "already dispatched" });
    }

    const template = EVENT_TEMPLATES[notification.event_type];
    if (!template) {
      return Response.json({ skipped: true, reason: `${notification.event_type} has no SMS template` });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("phone, sms_consent, notification_prefs")
      .eq("id", notification.user_id)
      .single();
    if (!profile?.phone || !profile.sms_consent) {
      await ctx.supabaseAdmin.from("notifications").update({ sms_dispatched: true }).eq("id", notificationId);
      return Response.json({ skipped: true, reason: "recipient has no phone or has not opted in" });
    }

    const prefs = profile.notification_prefs as { smsEvents?: Record<string, boolean> };
    if (prefs?.smsEvents?.[notification.event_type] === false) {
      await ctx.supabaseAdmin.from("notifications").update({ sms_dispatched: true }).eq("id", notificationId);
      return Response.json({ skipped: true, reason: "recipient opted out of this event type" });
    }

    const link = notification.job_id ? `${appUrl}/jobs/${notification.job_id}` : appUrl;
    const text = template(notification.title, notification.body, link);

    const sent = await sendSms(profile.phone, text);
    if (!sent) {
      return Response.json({ skipped: true, reason: "AWS SNS not configured or send failed" });
    }
    await ctx.supabaseAdmin.from("notifications").update({ sms_dispatched: true }).eq("id", notificationId);
    return Response.json({ sent: true });
  }),
};
