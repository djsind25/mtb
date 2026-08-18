import { useEffect, useRef, useState } from "react";
import { C, sans } from "../theme";
import { Btn, Field, ErrorMsg } from "../ui/Primitives";
import {
  getAAL, listVerifiedTotpFactors, listVerifiedWebauthnFactors, challengeAndVerify, authenticatePasskey,
  startEmailStepupCode, verifyEmailStepupCode,
} from "../lib/mfa";

// Re-verification gate in front of a sensitive already-authenticated action. Modes depending on
// what the account actually has to step up with:
//  - "passkey" / "totp": a verified real MFA factor exists — re-verify it fresh (passkey preferred
//    when both exist, since it's faster). For admin actions and for Supabase's own
//    auth.updateUser() (password/email change), this is real server-enforced protection: the
//    underlying RPC/GoTrue itself independently re-checks aal2, so a modified client request can't
//    skip it. An email-code-only account has nothing here — email code can never produce aal2 (see
//    the 2FA-methods migration) — so it falls straight to "password" below, same as an unenrolled
//    account always has.
//  - "password": no totp/passkey factor, but the account has a password — re-enter it (verified
//    for real against the live password via signInWithPassword). Real protection for actions
//    backed by an RPC that also checks the password server-side (e.g. deactivate_own_account); for
//    auth.updateUser() itself, GoTrue has no password-recheck of its own once already
//    authenticated, so this is a client-side speedbump only in that specific case.
//  - "email": only reachable from "password" mode, and only when the caller passes
//    allowEmailFallback — a transient "email me a code instead" alternative to retyping the
//    passcode (see email_stepup_codes / StepUp's onVerified call, which passes no password back).
//    Only safe for callers whose downstream action doesn't need the actual passcode value — see
//    the migration this shipped in for exactly why deactivate/delete don't get this option.
//  - "none": no factor and no password (pure OAuth account with neither enrolled) — nothing left
//    to verify beyond the already-live session, so this just asks for a plain confirm.
export function StepUpChallenge({ supabase, onVerified, onCancel, allowEmailFallback = false }) {
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState(null);
  const [factorId, setFactorId] = useState(null);
  const [email, setEmail] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const autoVerifiedRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const aal = await getAAL(supabase);
        if (aal.currentLevel === "aal2") {
          if (autoVerifiedRef.current) return;
          autoVerifiedRef.current = true;
          onVerified();
          return;
        }
        const [totpFactors, webauthnFactors] = await Promise.all([
          listVerifiedTotpFactors(supabase), listVerifiedWebauthnFactors(supabase),
        ]);
        if (webauthnFactors.length > 0) {
          setFactorId(webauthnFactors[0].id);
          setMode("passkey");
        } else if (totpFactors.length > 0) {
          setFactorId(totpFactors[0].id);
          setMode("totp");
        } else {
          const { data: { user } } = await supabase.auth.getUser();
          const hasPassword = user?.identities?.some((i) => i.provider === "email");
          if (hasPassword) {
            setEmail(user.email);
            setMode("password");
          } else {
            setMode("none");
          }
        }
      } catch (e) {
        setError(e.message || "Could not check verification status.");
      }
      setChecking(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      await authenticatePasskey(supabase, factorId);
      onVerified();
    } catch (e) {
      setError(e.message || "Could not verify your passkey — try again.");
    }
    setLoading(false);
  }

  async function submitPassword() {
    setError("");
    if (!password.trim()) { setError("Enter your passcode."); return; }
    setLoading(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: password.trim() });
      if (signInError) { setError("That passcode isn't correct."); setLoading(false); return; }
      onVerified(password.trim());
    } catch (e) {
      setError(e.message || "Could not verify your passcode.");
    }
    setLoading(false);
  }

  async function sendEmailCode() {
    setError("");
    setLoading(true);
    try {
      await startEmailStepupCode(supabase);
      setEmailCodeSent(true);
    } catch (e) {
      setError(e.message || "Could not send a code.");
    }
    setLoading(false);
  }

  async function submitEmailCode() {
    setError("");
    if (!code.trim()) { setError("Enter the 6-digit code from your email."); return; }
    setLoading(true);
    try {
      const ok = await verifyEmailStepupCode(supabase, code.trim());
      if (!ok) { setError("That code didn't match — try again."); setLoading(false); return; }
      onVerified();
    } catch (e) {
      setError(e.message || "Could not verify that code.");
    }
    setLoading(false);
  }

  if (checking) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: 16, padding: 24, width: "100%", maxWidth: 380, border: `1px solid ${C.line}` }}>
        <div style={{ fontFamily: sans, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>Verify it's you</div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>
          {mode === "passkey" && "This action requires verifying your passkey before it can continue."}
          {mode === "totp" && "This action requires a fresh two-factor code before it can continue."}
          {mode === "password" && "This action requires re-entering your passcode before it can continue."}
          {mode === "email" && !emailCodeSent && "We'll email a 6-digit code to confirm it's you, instead of re-entering your passcode."}
          {mode === "email" && emailCodeSent && "Enter the 6-digit code we just emailed you. It expires in 10 minutes."}
          {mode === "none" && "Confirm you'd like to continue with this action."}
        </div>
        {mode === "totp" && <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" required />}
        {mode === "password" && <Field label="Passcode" value={password} onChange={setPassword} type="password" placeholder="••••••" required />}
        {mode === "email" && emailCodeSent && <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" required />}
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <div style={{ display: "flex", gap: 8, fontFamily: sans }}>
          <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
          {mode === "passkey" && <Btn onClick={submitPasskey} disabled={loading}>{loading ? "Waiting…" : "Use passkey"}</Btn>}
          {mode === "totp" && <Btn onClick={submitTotp} disabled={loading}>{loading ? "Checking…" : "Verify"}</Btn>}
          {mode === "password" && <Btn onClick={submitPassword} disabled={loading}>{loading ? "Checking…" : "Verify"}</Btn>}
          {mode === "email" && !emailCodeSent && <Btn onClick={sendEmailCode} disabled={loading}>{loading ? "Sending…" : "Send code"}</Btn>}
          {mode === "email" && emailCodeSent && <Btn onClick={submitEmailCode} disabled={loading}>{loading ? "Checking…" : "Verify"}</Btn>}
          {mode === "none" && <Btn onClick={() => onVerified()}>Continue</Btn>}
        </div>
        {mode === "password" && allowEmailFallback && (
          <button onClick={() => { setMode("email"); setError(""); }} style={linkStyle}>
            Email me a code instead
          </button>
        )}
        {mode === "email" && (
          <button onClick={() => { setMode("password"); setEmailCodeSent(false); setCode(""); setError(""); }} style={linkStyle}>
            Use my passcode instead
          </button>
        )}
        {mode === "email" && emailCodeSent && (
          <button onClick={sendEmailCode} disabled={loading} style={linkStyle}>Resend code</button>
        )}
      </div>
    </div>
  );
}

const linkStyle = {
  background: "none", border: "none", color: C.gray, fontSize: 12, cursor: "pointer",
  textDecoration: "underline", marginTop: 12, display: "block", fontFamily: sans, padding: 0,
};
