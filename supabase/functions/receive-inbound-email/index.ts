// receive-inbound-email
//
// Internal endpoint: called by the AWS Lambda that processes emails arriving at
// support@mytrashbid.com (SES receipt rule -> S3 -> Lambda -> here). Not meant to be called by
// end users — auth is a shared secret header, but deliberately a *separate* secret
// (LAMBDA_INBOUND_KEY) from INTERNAL_DISPATCH_KEY: that one is shared with Postgres (which reads
// it from app_config to call the other dispatch-triggered functions), and this endpoint's only
// caller is AWS, not Postgres — reusing the same value would mean rotating one for the other,
// and a typo here can't accidentally break the Postgres-triggered notification/verification
// emails the way overwriting INTERNAL_DISPATCH_KEY could.
//
// Files the message into the same support_chats/support_messages tables the in-app "Contact
// Administrator" flow uses, via handle_inbound_support_email() — that RPC finds the sender's
// profile by email (or creates a profile-less "guest" chat if there's no match) and is only
// callable by service_role, since it lets the caller assert an arbitrary "from" identity.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

const sharedSecret = Deno.env.get("LAMBDA_INBOUND_KEY") ?? "";

export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    if (req.headers.get("apikey") !== sharedSecret || !sharedSecret) {
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { from, subject, text } = await req.json().catch(() => ({}));
    if (!from || !text) {
      return Response.json({ message: "from and text are required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabaseAdmin.rpc("handle_inbound_support_email", {
      p_email: from,
      p_subject: subject ?? null,
      p_body: text,
    });
    if (error) {
      console.error("receive-inbound-email: RPC failed:", error);
      return Response.json({ message: "Could not file support message" }, { status: 502 });
    }

    return Response.json({ supportChatId: data });
  }),
};
