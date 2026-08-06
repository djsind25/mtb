// send-web-push
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by dispatch_notification_push() —
// currently wired to exactly three triggers: a new bid landing (bidReceived), a bid being
// accepted (bidAccepted + jobBooked), and a new chat message (newMessage, customer/hauler only).
// Not meant to be called by end users — auth is a shared secret header, same pattern as
// send-notification/send-sms-notification.
//
// Unlike email/SMS there's no single "opted in" profile column — a person can have a push
// subscription on more than one device, so every row in push_subscriptions for this user gets a
// push. A subscription that comes back 404/410 (browser unsubscribed, or the OS purged it) is
// deleted here — that's the standard web-push cleanup pattern, not an error.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import webpush from "web-push";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:support@mytrashbid.com";
const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:5173";

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

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
    if (notification.push_dispatched) {
      return Response.json({ skipped: true, reason: "already dispatched" });
    }

    const { data: profile } = await ctx.supabaseAdmin
      .from("profiles")
      .select("notification_prefs")
      .eq("id", notification.user_id)
      .single();
    const prefs = profile?.notification_prefs as { pushEvents?: Record<string, boolean> } | undefined;
    if (prefs?.pushEvents?.[notification.event_type] === false) {
      await ctx.supabaseAdmin.from("notifications").update({ push_dispatched: true }).eq("id", notificationId);
      return Response.json({ skipped: true, reason: "recipient opted out of this event type" });
    }

    if (!vapidPublicKey || !vapidPrivateKey) {
      console.warn(`send-web-push: VAPID keys not set, skipping push for ${notificationId}`);
      return Response.json({ skipped: true, reason: "VAPID keys not configured" });
    }

    const { data: subscriptions } = await ctx.supabaseAdmin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .eq("user_id", notification.user_id);
    if (!subscriptions || subscriptions.length === 0) {
      await ctx.supabaseAdmin.from("notifications").update({ push_dispatched: true }).eq("id", notificationId);
      return Response.json({ skipped: true, reason: "no push subscriptions on file" });
    }

    const link = notification.job_id ? `${appUrl}/jobs/${notification.job_id}` : appUrl;
    const payload = JSON.stringify({ title: notification.title, body: notification.body ?? "", url: link });

    let sentCount = 0;
    await Promise.all(subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sentCount++;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await ctx.supabaseAdmin.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          console.error("send-web-push: sendNotification failed:", err);
        }
      }
    }));

    await ctx.supabaseAdmin.from("notifications").update({ push_dispatched: true }).eq("id", notificationId);
    return Response.json({ sent: sentCount, subscriptions: subscriptions.length });
  }),
};
