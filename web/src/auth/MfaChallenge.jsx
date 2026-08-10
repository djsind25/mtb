import { useEffect, useState } from "react";
import { C } from "../theme";
import { Btn, Field, ErrorMsg, CenteredNote } from "../ui/Primitives";
import { listVerifiedTotpFactors, listVerifiedWebauthnFactors, challengeAndVerify, authenticatePasskey, redeemRecoveryCode } from "../lib/mfa";

// Login-time gate: enter a 6-digit code from an already-enrolled authenticator, use an enrolled
// passkey, or fall back to a one-time recovery code. Email code is never offered here — it can't
// produce a real aal2 session (see the 2FA-methods migration), and this screen only ever appears
// for admins, whose enrollment never offers email in the first place (MfaEnrollment's
// excludeEmail). A recovery code doesn't bump the session to aal2 itself (see mfa.js) —
// onRecoveryCodeAccepted should route the caller into mandatory re-enrollment, not straight into
// the app, so a fresh factor's own verify() re-establishes aal2.
export function MfaChallenge({ supabase, onVerified, onRecoveryCodeAccepted, onBack }) {
  const [factorId, setFactorId] = useState(null);
  const [passkeyFactorId, setPasskeyFactorId] = useState(null);
  const [mode, setMode] = useState("totp"); // totp | passkey | recovery
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [totpFactors, webauthnFactors] = await Promise.all([
          listVerifiedTotpFactors(supabase), listVerifiedWebauthnFactors(supabase),
        ]);
        setFactorId(totpFactors[0]?.id || null);
        setPasskeyFactorId(webauthnFactors[0]?.id || null);
        // Passkey first when both exist — it's the faster, stronger option (no typing).
        setMode(webauthnFactors[0]?.id ? "passkey" : "totp");
      } catch (e) {
        setError(e.message || "Could not load your two-factor methods.");
      }
      setReady(true);
    })();
  }, [supabase]);

  async function submitTotp() {
    setError("");
    if (!code.trim()) { setError("Enter a code."); return; }
    setLoading(true);
    try {
      await challengeAndVerify(supabase, factorId, code.trim());
      onVerified();
    } catch (e) {
      setError(e.message || "That code didn't match — try again.");
    }
    setLoading(false);
  }

  async function submitPasskey() {
    setError("");
    setLoading(true);
    try {
      await authenticatePasskey(supabase, passkeyFactorId);
      onVerified();
    } catch (e) {
      setError(e.message || "Could not verify your passkey — try again.");
    }
    setLoading(false);
  }

  async function submitRecovery() {
    setError("");
    if (!code.trim()) { setError("Enter a code."); return; }
    setLoading(true);
    try {
      const ok = await redeemRecoveryCode(supabase, code.trim());
      if (!ok) { setError("That recovery code isn't valid or has already been used."); setLoading(false); return; }
      onRecoveryCodeAccepted();
    } catch (e) {
      setError(e.message || "That code didn't match — try again.");
    }
    setLoading(false);
  }

  if (!ready) return <CenteredNote>Loading…</CenteredNote>;

  return (
    <div>
      <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 16 }}>
        {mode === "totp" && "Enter the 6-digit code from your authenticator app."}
        {mode === "passkey" && "Use your passkey (Face ID, fingerprint, or security key) to continue."}
        {mode === "recovery" && "Enter one of your saved backup recovery codes."}
      </div>
      {mode === "totp" && <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" required />}
      {mode === "recovery" && <Field label="Recovery code" value={code} onChange={setCode} placeholder="xxxx-xxxx" required />}
      {error && <ErrorMsg>{error}</ErrorMsg>}
      {mode === "totp" && <Btn onClick={submitTotp} disabled={loading || !factorId} size="lg">{loading ? "Checking…" : "Verify"}</Btn>}
      {mode === "passkey" && <Btn onClick={submitPasskey} disabled={loading || !passkeyFactorId} size="lg">{loading ? "Waiting…" : "Use passkey"}</Btn>}
      {mode === "recovery" && <Btn onClick={submitRecovery} disabled={loading} size="lg">{loading ? "Checking…" : "Verify"}</Btn>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
        {mode !== "passkey" && passkeyFactorId && (
          <button onClick={() => { setMode("passkey"); setCode(""); setError(""); }} style={linkStyle}>Use my passkey instead</button>
        )}
        {mode !== "totp" && factorId && (
          <button onClick={() => { setMode("totp"); setCode(""); setError(""); }} style={linkStyle}>Use my authenticator app instead</button>
        )}
        {mode !== "recovery" && (
          <button onClick={() => { setMode("recovery"); setCode(""); setError(""); }} style={linkStyle}>Use a recovery code instead</button>
        )}
      </div>
      {onBack && (
        <button onClick={onBack} style={{ ...linkStyle, marginTop: 8 }}>Not you? Sign out</button>
      )}
    </div>
  );
}

const linkStyle = {
  background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
  textDecoration: "underline", display: "block", padding: 0, textAlign: "left",
};
