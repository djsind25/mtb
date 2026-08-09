// send-monthly-export
//
// Internal endpoint: fired (fire-and-forget, via pg_net) by dispatch_monthly_export() — either
// the pg_cron job on the 1st of each month (run_monthly_export(), only if the auto_export_enabled
// app_config toggle is on) or the super admin's "Send test export now" button
// (send_monthly_export_now(), which ignores that toggle). Not meant to be called by end users —
// auth is a shared secret header, checked manually below, so `auth: "none"` at the wrapper level
// plus `verify_jwt = false` in supabase/config.toml for this function.
//
// The request body only ever carries {monthStart, monthEnd} — recipient email and all financial
// content are looked up here via get_monthly_export_data() (service_role-only), not trusted from
// the caller. Unlike every other field in this codebase, INTERNAL_DISPATCH_KEY is shared across 8
// functions; this one used to be the exception that took recipient/content straight from the body,
// which would have made a leaked key into an open relay for arbitrary email content to an
// arbitrary address. See 20260825000000_monthly_export_data_trust.sql.
//
// Emails the super admin a CSV attachment (revenue summary + completed-job line items for the
// reported month) instead of just an inline HTML table, so it's straightforward to keep for tax
// records or hand to a bookkeeper.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Resend } from "resend";
import { timingSafeEqualString } from "../_shared/timingSafeEqual.ts";

const internalKey = Deno.env.get("INTERNAL_DISPATCH_KEY") ?? "";
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromAddress = Deno.env.get("RESEND_FROM_EMAIL") ?? "MyTrashBid <bids@mytrashbid.com>";

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(monthLabel: string, revenue: Record<string, number>, completedJobs: Array<Record<string, unknown>>): string {
  const lines = [
    `MyTrashBid monthly export — ${monthLabel}`,
    "",
    "Revenue summary",
    "Booked jobs,GMV,Deposit revenue (10%),Paid hauler-direct (90%)",
    [revenue.bookedJobs, revenue.gmv.toFixed(2), revenue.deposit.toFixed(2), revenue.haulerDirect.toFixed(2)].join(","),
    "",
    "Completed jobs",
    "Title,Customer,Hauler,Amount,Completed at",
  ];
  for (const j of completedJobs) {
    lines.push([csvEscape(j.title), csvEscape(j.customer), csvEscape(j.hauler), Number(j.amount).toFixed(2), csvEscape(j.completedAt)].join(","));
  }
  return lines.join("\n");
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (!internalKey || !timingSafeEqualString(req.headers.get("apikey") ?? "", internalKey)) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { monthStart, monthEnd } = await req.json().catch(() => ({}));
    if (!monthStart || !monthEnd) {
      return Response.json({ message: "monthStart and monthEnd are required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabaseAdmin
      .rpc("get_monthly_export_data", { p_month_start: monthStart, p_month_end: monthEnd })
      .single();
    if (error) {
      console.error("send-monthly-export: get_monthly_export_data failed:", error);
      return Response.json({ message: "Could not load export data" }, { status: 502 });
    }
    if (!data) {
      // No super admin found — dispatch_monthly_export() itself already no-ops in this case, but
      // handle it defensively here too since this function can also be invoked directly.
      return Response.json({ skipped: true, reason: "No super admin to email" });
    }
    const { email, monthLabel, revenue, completedJobs } = data as {
      email: string; monthLabel: string; revenue: Record<string, number>; completedJobs: Array<Record<string, unknown>>;
    };

    if (!resendApiKey) {
      console.warn("send-monthly-export: RESEND_API_KEY not set, skipping email");
      return Response.json({ skipped: true, reason: "RESEND_API_KEY not configured" });
    }

    const jobs = Array.isArray(completedJobs) ? completedJobs : [];
    const csv = buildCsv(monthLabel, revenue, jobs);
    // btoa only handles Latin1 — this UTF-8-safe encode-then-decode trick keeps names/titles with
    // non-ASCII characters (e.g. curly apostrophes) from corrupting the attachment.
    const csvBase64 = btoa(unescape(encodeURIComponent(csv)));

    try {
      const resend = new Resend(resendApiKey);
      await resend.emails.send({
        from: fromAddress,
        to: email,
        subject: `MyTrashBid revenue export — ${monthLabel}`,
        html: `<h2>${monthLabel} summary</h2>` +
          `<table cellpadding="6"><tr><td>Booked jobs</td><td><strong>${revenue.bookedJobs}</strong></td></tr>` +
          `<tr><td>GMV</td><td><strong>$${Number(revenue.gmv).toFixed(2)}</strong></td></tr>` +
          `<tr><td>Deposit revenue (10%)</td><td><strong>$${Number(revenue.deposit).toFixed(2)}</strong></td></tr>` +
          `<tr><td>Paid hauler-direct (90%)</td><td><strong>$${Number(revenue.haulerDirect).toFixed(2)}</strong></td></tr></table>` +
          `<p>${jobs.length} job${jobs.length === 1 ? "" : "s"} completed this month — full detail in the attached CSV.</p>`,
        attachments: [{ filename: `mytrashbid-export-${monthLabel.replace(" ", "-")}.csv`, content: csvBase64 }],
      });
      return Response.json({ sent: true });
    } catch (err) {
      console.error("send-monthly-export: Resend call failed:", err);
      return Response.json({ message: "Email send failed" }, { status: 502 });
    }
  }),
};
