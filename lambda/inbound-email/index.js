// inbound-email Lambda
//
// Triggered by an SES receipt rule for support@mytrashbid.com: the rule's S3 action stores the
// raw MIME email first (keyed by SES message id), then invokes this function. We fetch that
// object, parse it, and forward {from, subject, text} to the receive-inbound-email Supabase
// Edge Function, which files it into support_chats/support_messages.
//
// Env vars (set on the Lambda):
//   EMAIL_BUCKET          - S3 bucket the SES rule writes raw emails to
//   EMAIL_PREFIX          - optional key prefix configured on the SES S3 action (e.g. "inbound")
//   EDGE_FUNCTION_URL     - https://<project-ref>.supabase.co/functions/v1/receive-inbound-email
//   LAMBDA_INBOUND_KEY    - shared secret the Edge Function checks; a dedicated secret, not the
//                           same as Postgres's INTERNAL_DISPATCH_KEY (see the Edge Function's
//                           own header comment for why they're kept separate)

const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { simpleParser } = require("mailparser");
const https = require("https");

const s3 = new S3Client({});

exports.handler = async (event) => {
  const bucket = process.env.EMAIL_BUCKET;
  const prefix = process.env.EMAIL_PREFIX || "";
  const edgeFunctionUrl = process.env.EDGE_FUNCTION_URL;
  const internalKey = process.env.LAMBDA_INBOUND_KEY;

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

      const { statusCode, body } = await postJson(edgeFunctionUrl, { from, subject, text }, internalKey);
      if (statusCode >= 400) {
        console.error(`inbound-email: receive-inbound-email returned ${statusCode} for ${messageId}: ${body}`);
      }
    } catch (err) {
      // Don't rethrow — one bad email shouldn't fail the whole batch, and there's nowhere
      // upstream (SES) that would usefully retry this.
      console.error(`inbound-email: failed processing ${messageId}:`, err);
    }
  }

  return { statusCode: 200 };
};

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
