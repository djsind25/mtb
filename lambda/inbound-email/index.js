// inbound-email Lambda
//
// Triggered by an SES receipt rule for support@mytrashbid.com: the rule's S3 action stores the
// raw MIME email first (keyed by SES message id), then invokes this function. We fetch that
// object, parse it, forward {from, subject, text} to the receive-inbound-email Supabase Edge
// Function (which files it into support_chats/support_messages), and — if FORWARD_TO_EMAIL is
// set — also relay a copy of the original email via SES to that address.
//
// Env vars (set on the Lambda):
//   EMAIL_BUCKET          - S3 bucket the SES rule writes raw emails to
//   EMAIL_PREFIX          - optional key prefix configured on the SES S3 action (e.g. "inbound")
//   EDGE_FUNCTION_URL     - https://<project-ref>.supabase.co/functions/v1/receive-inbound-email
//   LAMBDA_INBOUND_KEY    - shared secret the Edge Function checks; a dedicated secret, not the
//                           same as Postgres's INTERNAL_DISPATCH_KEY (see the Edge Function's
//                           own header comment for why they're kept separate)
//   FORWARD_TO_EMAIL      - optional; if set, every inbound support email is also relayed here
//                           (e.g. djsind25@gmail.com) so it lands in a real inbox too

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SESClient, SendRawEmailCommand } = require("@aws-sdk/client-ses");
const { simpleParser } = require("mailparser");
const MailComposer = require("nodemailer/lib/mail-composer");
const https = require("https");

const s3 = new S3Client({});
const ses = new SESClient({});

exports.handler = async (event) => {
  const bucket = process.env.EMAIL_BUCKET;
  const prefix = process.env.EMAIL_PREFIX || "";
  const edgeFunctionUrl = process.env.EDGE_FUNCTION_URL;
  const internalKey = process.env.LAMBDA_INBOUND_KEY;
  const forwardTo = process.env.FORWARD_TO_EMAIL;

  for (const record of event.Records || []) {
    const messageId = record.ses?.mail?.messageId;
    if (!messageId) continue;

    const key = prefix ? `${prefix}/${messageId}` : messageId;

    try {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const raw = await streamToBuffer(object.Body);
      const parsed = await simpleParser(raw);

      const from = parsed.from?.value?.[0]?.address;
      if (!from) {
        console.warn(`inbound-email: no From address parsed for ${messageId}, skipping`);
        continue;
      }

      const subject = parsed.subject || "";
      const text = parsed.text || (parsed.html ? stripHtml(parsed.html) : "(no content)");

      const [ticketResult, forwardResult] = await Promise.allSettled([
        postJson(edgeFunctionUrl, { from, subject, text }, internalKey),
        forwardTo ? forwardEmail({ parsed, forwardTo }) : Promise.resolve(null),
      ]);

      if (ticketResult.status === "fulfilled") {
        const { statusCode, body } = ticketResult.value;
        if (statusCode >= 400) {
          console.error(`inbound-email: receive-inbound-email returned ${statusCode} for ${messageId}: ${body}`);
        }
      } else {
        console.error(`inbound-email: posting ticket failed for ${messageId}:`, ticketResult.reason);
      }

      if (forwardTo && forwardResult.status === "rejected") {
        console.error(`inbound-email: forwarding to ${forwardTo} failed for ${messageId}:`, forwardResult.reason);
      }
    } catch (err) {
      // Don't rethrow — one bad email shouldn't fail the whole batch, and there's nowhere
      // upstream (SES) that would usefully retry this.
      console.error(`inbound-email: failed processing ${messageId}:`, err);
    }
  }

  return { statusCode: 200 };
};

// Relays a copy of the parsed email to `forwardTo` via SES. Sends "From" support@mytrashbid.com
// (the only address SES will let this account send as) with the original sender preserved as
// Reply-To, so replies from the forward target go straight back to the customer.
async function forwardEmail({ parsed, forwardTo }) {
  const originalFrom = parsed.from?.text || parsed.from?.value?.[0]?.address || "unknown sender";

  const mail = new MailComposer({
    from: `"MyTrashBid Support (fwd)" <support@mytrashbid.com>`,
    to: forwardTo,
    replyTo: originalFrom,
    subject: `[Support] ${parsed.subject || "(no subject)"}`,
    text: parsed.text || "(no content)",
    html: parsed.html || undefined,
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  });

  const raw = await mail.compile().build();
  // Source must be set explicitly: without it, SES's IAM authorization check resolves the
  // sending identity ambiguously instead of matching support@mytrashbid.com (the only identity
  // our IAM policy grants ses:SendRawEmail on).
  await ses.send(new SendRawEmailCommand({ RawMessage: { Data: raw }, Source: "support@mytrashbid.com" }));
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function postJson(urlString, payload, apikey) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(urlString);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          apikey,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
