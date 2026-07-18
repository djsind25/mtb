// send-admin-invite
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by create_admin_invite() right after an
// admin_invites row is created. Not meant to be called by end users — auth is a shared secret
// header, checked manually below, so `auth: "none"` at the wrapper level plus `verify_jwt = false`
// in supabase/config.toml for this function.
//
// The link points at the web app (not the marketing site) — accepting an invite means signing up
// and landing straight in the admin dashboard, which only the app knows how to do.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";
const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:5173";

// inviter.name is a stored profile name — escape before interpolating into the email HTML.
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== internalKey || !internalKey) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { inviteId } = await req.json().catch(() => ({}));
    if (!inviteId) {
      return Response.json({ message: "inviteId is required" }, { status: 400 });
    }

    const { data: invite } = await ctx.supabaseAdmin
      .from("admin_invites")
      .select("email, admin_read_only, accepted_at, token, invited_by")
      .eq("id", inviteId)
      .single();
    if (!invite?.email || !invite.token) {
      return Response.json({ skipped: true, reason: "no invite/email/token" });
    }
    if (invite.accepted_at) {
      return Response.json({ skipped: true, reason: "already accepted" });
    }

    if (!resendApiKey) {
      console.warn(`send-admin-invite: RESEND_API_KEY not set, skipping email for ${inviteId}`);
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const { data: inviter } = await ctx.supabaseAdmin
      .from("profiles").select("name").eq("id", invite.invited_by).single();

    const roleLabel = invite.admin_read_only ? "view-only admin" : "full admin";
    const link = `${appUrl}/?admin_invite=${invite.token}`;

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromAddress,
        to: invite.email,
        subject: "You've been invited to MyTrashBid as an admin",
        html: `<h2>You've been invited${inviter?.name ? ` by ${escapeHtml(inviter.name)}` : ""}.</h2>` +
          `<p>You're being added as a <strong>${roleLabel}</strong> on MyTrashBid.</p>` +
          `<p><a href="${link}">Set up your admin account</a></p>` +
          `<p>This link expires in 7 days.</p>`,
      });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-admin-invite: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
