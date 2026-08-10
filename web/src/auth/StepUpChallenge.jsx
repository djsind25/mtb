import { useEffect, useRef, useState } from "react";
import { C, sans } from "../theme";
import { Btn, Field, ErrorMsg } from "../ui/Primitives";
import { getAAL, listVerifiedTotpFactors, listVerifiedWebauthnFactors, challengeAndVerify, authenticatePasskey } from "../lib/mfa";

// Re-verification gate in front of a sensitive already-authenticated action. Four modes depending
// on what the account actually has to step up with:
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
//  - "none": no factor and no password (pure OAuth account with neither enrolled) — nothing left
//    to verify beyond the already-live session, so this just asks for a plain confirm.
export function StepUpChallenge({ supabase, onVerified, onCancel }) {
  const [checking, setChecking] = useState(true);
  const [mode, setMode] = useState(null);
  const [factorId, setFactorId] = useState(null);
  const [email, setEmail] = useState(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
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
          {mode === "none" && "Confirm you'd like to continue with this action."}
        </div>
        {mode === "totp" && <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" required />}
        {mode === "password" && <Field label="Passcode" value={password} onChange={setPassword} type="password" placeholder="••••••" required />}
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <div style={{ display: "flex", gap: 8, fontFamily: sans }}>
          <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
          {mode === "passkey" && <Btn onClick={submitPasskey} disabled={loading}>{loading ? "Waiting…" : "Use passkey"}</Btn>}
          {mode === "totp" && <Btn onClick={submitTotp} disabled={loading}>{loading ? "Checking…" : "Verify"}</Btn>}
          {mode === "password" && <Btn onClick={submitPassword} disabled={loading}>{loading ? "Checking…" : "Verify"}</Btn>}
          {mode === "none" && <Btn onClick={() => onVerified()}>Continue</Btn>}
        </div>
      </div>
    </div>
  );
}
