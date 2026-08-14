# inbound-email Lambda

Parses emails SES received for `support@mytrashbid.com` and forwards them to the
`receive-inbound-email` Supabase Edge Function.

## Deploy

```bash
cd lambda/inbound-email
npm install
zip -r ../inbound-email.zip . -x "*.md"
aws lambda update-function-code --function-name mytrashbid-inbound-email --zip-file fileb://../inbound-email.zip
```

(Use `create-function` instead of `update-function-code` the first time — see the AWS setup
notes for the full receipt-rule/role/trigger-permission steps.)

## Environment variables

| Var | Value |
|---|---|
| `EMAIL_BUCKET` | the S3 bucket the SES receipt rule stores raw emails in |
| `EMAIL_PREFIX` | key prefix configured on the SES S3 action, if any (blank if none) |
| `EDGE_FUNCTION_URL` | `https://<project-ref>.supabase.co/functions/v1/receive-inbound-email` |
| `LAMBDA_INBOUND_KEY` | same value as the Supabase project's `LAMBDA_INBOUND_KEY` secret |
| `FORWARD_TO_EMAIL` | optional — if set (e.g. `djsind25@gmail.com`), every inbound support email is also relayed there via SES, in addition to filing the support ticket |

## Forwarding a copy to a real inbox

`support@mytrashbid.com` isn't a mailbox — SES receives it and this Lambda is the only thing
that ever sees it. To also get a copy in a real inbox, set `FORWARD_TO_EMAIL` and grant the
Lambda's execution role `ses:SendRawEmail` (see `../aws-setup/ses-send-policy.json`):

```bash
aws iam put-role-policy \
  --role-name <lambda-execution-role-name> \
  --policy-name ses-send-forward \
  --policy-document file://../aws-setup/ses-send-policy.json

aws lambda update-function-configuration \
  --function-name mytrashbid-inbound-email \
  --environment "Variables={EMAIL_BUCKET=mytrashbid-inbound-email,EDGE_FUNCTION_URL=<edge-function-url>,LAMBDA_INBOUND_KEY=<key>,FORWARD_TO_EMAIL=djsind25@gmail.com}"
```

(`update-function-configuration` replaces the whole `Variables` map, so include the existing
vars too — check current values first with `aws lambda get-function-configuration`.)

The forwarded mail is sent `From: support@mytrashbid.com` with `Reply-To:` set to the original
sender, since SES can only send as an address on a verified identity (`mytrashbid.com`) — replying
to the forwarded copy still reaches the customer. If this SES account is still in the sandbox,
the forward-to address must also be a verified identity before mail will actually deliver; check
with `aws ses get-account-sending-enabled` / `aws ses list-identities` and request production
access if needed.
