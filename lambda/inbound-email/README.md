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
