import { useEffect, useState } from "react";
import { C } from "../theme";
import { Btn, Field, ErrorMsg, CenteredNote } from "../ui/Primitives";
import { listVerifiedTotpFactors, challengeAndVerify, redeemRecoveryCode } from "../lib/mfa";

// Login-time gate: enter a 6-digit code from an already-enrolled authenticator, or fall back to a
// one-time recovery code. A recovery code doesn't bump the session to aal2 itself (see mfa.js) —
// onRecoveryCodeAccepted should route the caller into mandatory re-enrollment, not straight into
// the app, so a fresh factor's own verify() re-establishes aal2.
export function MfaChallenge({ supabase, onVerified, onRecoveryCodeAccepted, onBack }) {
  const [factorId, setFactorId] = useState(null);
  const [mode, setMode] = useState("totp"); // totp | recovery
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const factors = await listVerifiedTotpFactors(supabase);
        setFactorId(factors[0]?.id || null);
      } catch (e) {
        setError(e.message || "Could not load your authenticator.");
      }
      setReady(true);
    })();
  }, [supabase]);

  async function submit() {
    setError("");
    if (!code.trim()) { setError("Enter a code."); return; }
    setLoading(true);
    try {
      if (mode === "totp") {
        await challengeAndVerify(supabase, factorId, code.trim());
        onVerified();
      } else {
        const ok = await redeemRecoveryCode(supabase, code.trim());
        if (!ok) { setError("That recovery code isn't valid or has already been used."); setLoading(false); return; }
        onRecoveryCodeAccepted();
      }
    } catch (e) {
      setError(e.message || "That code didn't match — try again.");
    }
    setLoading(false);
  }

  if (!ready) return <CenteredNote>Loading…</CenteredNote>;

  return (
    <div>
      <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 16 }}>
        {mode === "totp"
          ? "Enter the 6-digit code from your authenticator app."
          : "Enter one of your saved backup recovery codes."}
      </div>
      <Field
        label={mode === "totp" ? "6-digit code" : "Recovery code"}
        value={code} onChange={setCode}
        placeholder={mode === "totp" ? "123456" : "xxxx-xxxx"}
        required
      />
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <Btn onClick={submit} disabled={loading || (mode === "totp" && !factorId)} size="lg">{loading ? "Checking…" : "Verify"}</Btn>
      <button onClick={() => { setMode(mode === "totp" ? "recovery" : "totp"); setCode(""); setError(""); }} style={{
        background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
        textDecoration: "underline", marginTop: 14, display: "block",
      }}>{mode === "totp" ? "Use a recovery code instead" : "Use my authenticator app instead"}</button>
      {onBack && (
        <button onClick={onBack} style={{
          background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
          textDecoration: "underline", marginTop: 8, display: "block",
        }}>Not you? Sign out</button>
      )}
    </div>
  );
}
