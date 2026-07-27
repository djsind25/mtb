// Thin wrappers around Supabase's native TOTP MFA + this app's custom recovery-code RPCs.
// Every function takes `supabase` explicitly rather than importing the singleton, matching the
// pattern already established in socialAuth.js.

export async function listVerifiedTotpFactors(supabase) {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return (data?.totp || []).filter((f) => f.status === "verified");
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

// Redeeming a code does NOT bump the session to aal2 (only a real TOTP verify() does that) — it
// also strips the user's existing factor(s) server-side, so callers should always follow a
// successful redemption with mandatory re-enrollment, not treat it as equivalent to a completed
// login-MFA challenge.
export async function redeemRecoveryCode(supabase, code) {
  const { data, error } = await supabase.rpc("redeem_mfa_recovery_code", { p_code: code });
  if (error) throw error;
  return data; // boolean
}
