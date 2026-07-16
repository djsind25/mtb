// send-support-reply
//
// Internal endpoint: fired (fire-and-forget, via pg_net) whenever an admin sends a support
// message on a chat that has an email on file (support_chats.sender_email) — see
// dispatch_support_reply_email() and the assign_support_chat_on_admin_reply() trigger. Not meant
// to be called by end users — auth is a shared secret header, same pattern as the other
// dispatch-triggered functions.
//
// Sends from support@ (not the usual bids@ address) so a reply to this email lands back at
// support@mytrashbid.com and re-enters the same inbound pipeline, continuing the thread.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== internalKey || !internalKey) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { messageId } = await req.json().catch(() => ({}));
    if (!messageId) {
      return Response.json({ message: "messageId is required" }, { status: 400 });
    }

    const { data: message, error: messageError } = await ctx.supabaseAdmin
      .from("support_messages")
      .select("text, sender_role, support_chat_id")
      .eq("id", messageId)
      .single();
    if (messageError || !message || message.sender_role !== "admin") {
      return Response.json({ skipped: true, reason: "not an admin reply" });
    }

    const { data: chat } = await ctx.supabaseAdmin
      .from("support_chats")
      .select("sender_email")
      .eq("id", message.support_chat_id)
      .single();
    if (!chat?.sender_email) {
      return Response.json({ skipped: true, reason: "chat has no email on file" });
    }

    if (!resendApiKey) {
      console.warn(`send-support-reply: RESEND_API_KEY not set, skipping email for ${messageId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: "MyTrashBid Support <support@mytrashbid.com>",
        to: chat.sender_email,
        subject: "Re: your MyTrashBid support request",
        html: `<p>${message.text.replace(/\n/g, "<br>")}</p>` +
          `<p style="color:#888;font-size:12px;">Reply to this email to continue the conversation.</p>`,
      });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-support-reply: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
