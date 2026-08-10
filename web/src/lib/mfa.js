// Thin wrappers around Supabase's native TOTP MFA + this app's custom recovery-code RPCs.
// Every function takes `supabase` explicitly rather than importing the singleton, matching the
// pattern already established in socialAuth.js.

export async function listVerifiedTotpFactors(supabase) {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.totp || []).filter((f) => f.status === "verified");
}

// Passkey factors land in the same auth.mfa_factors table TOTP does (factor_type: "webauthn"),
// but listFactors()'s per-type grouping only covers totp/phone — webauthn factors only show up in
// the flat `all` array, so this filters that instead.
export async function listVerifiedWebauthnFactors(supabase) {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.all || []).filter((f) => f.factor_type === "webauthn" && f.status === "verified");
}

export async function getAAL(supabase) {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw error;
  return data; // { currentLevel, nextLevel }
}

export async function enrollTotp(supabase) {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
  if (error) throw error;
  return data; // { id, totp: { qr_code, secret, uri } }
}

export async function challengeAndVerify(supabase, factorId, code) {
  const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeError) throw challengeError;
  const { data, error } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  if (error) throw error;
  return data;
}

export async function unenrollFactor(supabase, factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

export async function generateRecoveryCodes(supabase) {
  const { data, error } = await supabase.rpc("generate_mfa_recovery_codes");
  if (error) throw error;
  return data; // text[]
}

// ─── Passkey (WebAuthn) — real Supabase Auth MFA, marked "experimental" by Supabase itself but
// functionally live in the installed SDK version. .register() does enroll+challenge+verify in one
// browser ceremony (Face ID / fingerprint / security key prompt); .authenticate() does the same
// for an existing factor at login time or step-up. Requires [auth.mfa.web_authn] +
// [auth.webauthn] enabled in config.toml and pushed to the project — see that file.
export async function enrollPasskey(supabase, friendlyName = "Passkey") {
  const { data, error } = await supabase.auth.mfa.webauthn.register({ friendlyName });
  if (error) throw error;
  return data;
}

export async function authenticatePasskey(supabase, factorId) {
  const { data, error } = await supabase.auth.mfa.webauthn.authenticate({ factorId });
  if (error) throw error;
  return data;
}

export function browserSupportsPasskeys() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

// ─── Email code — NOT a native Supabase MFA factor type (Supabase only supports totp/phone/
// webauthn), so this is fully custom: a 6-digit code emailed via send-mfa-email-code, hashed at
// rest, verified server-side. Enrolling one satisfies user_has_verified_mfa() (the hauler bid-gate
// check) but can never produce a real aal2 session — see the migration this shipped in
// (20260829000000_2fa_additional_methods.sql) for why, and StepUpChallenge.jsx for how step-up
// still falls back to a passcode re-entry for an email-code-only account.
export async function startEmailMfaEnrollment(supabase) {
  const { error } = await supabase.rpc("start_email_mfa_enrollment");
  if (error) throw error;
}

export async function verifyEmailMfaCode(supabase, code) {
  const { data, error } = await supabase.rpc("verify_email_mfa_code", { p_code: code });
  if (error) throw error;
  return data; // text[] recovery codes, minted in the same call — see the migration for why
}

export async function removeEmailMfaFactor(supabase) {
  const { error } = await supabase.rpc("remove_email_mfa_factor");
  if (error) throw error;
}

export async function hasEmailMfaFactor(supabase) {
  const { data, error } = await supabase.from("email_mfa_factors").select("id").eq("status", "verified").maybeSingle();
  if (error) throw error;
  return !!data;
}

// Single source of truth for "does this account satisfy the MFA bid-gate" — mirrors
// user_has_verified_mfa() server-side exactly (totp OR webauthn OR email), so the client never
// has to duplicate that OR logic across totp/webauthn/email checks.
export async function hasVerifiedMfa(supabase) {
  const { data, error } = await supabase.rpc("user_has_verified_mfa_self");
  if (error) throw error;
  return !!data;
}

export async function loadAllowedMfaMethods(supabase) {
  const { data, error } = await supabase.from("security_policy_config").select("allowed_mfa_methods").eq("id", true).single();
  if (error) throw error;
  return data.allowed_mfa_methods; // e.g. ["passkey", "totp", "email"]
}

export async function setAllowedMfaMethods(supabase, methods) {
  const { error } = await supabase.rpc("set_allowed_mfa_methods", { p_methods: methods });
  if (error) throw error;
}

// Redeeming a code does NOT bump the session to aal2 (only a real TOTP verify() does that) — it
// also strips the user's existing factor(s) server-side, so callers should always follow a
// successful redemption with mandatory re-enrollment, not treat it as equivalent to a completed
// login-MFA challenge.
export async function redeemRecoveryCode(supabase, code) {
  const { data, error } = await supabase.rpc("redeem_mfa_recovery_code", { p_code: code });
  if (error) throw error;
  return data; // boolean
}
