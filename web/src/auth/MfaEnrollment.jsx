import { useEffect, useState } from "react";
import { C, sans } from "../theme";
import { Btn, Field, ErrorMsg, Badge } from "../ui/Primitives";
import {
  listVerifiedTotpFactors, listVerifiedWebauthnFactors, enrollTotp, challengeAndVerify, unenrollFactor,
  generateRecoveryCodes, enrollPasskey, browserSupportsPasskeys, startEmailMfaEnrollment, verifyEmailMfaCode,
  hasEmailMfaFactor, removeEmailMfaFactor, loadAllowedMfaMethods,
} from "../lib/mfa";

const METHODS = [
  { id: "passkey", label: "Passkey", tagline: "Face ID / fingerprint", helper: "Easiest and most secure — nothing to install, uses your device's built-in unlock." },
  { id: "totp", label: "Authenticator app", tagline: "Recommended", helper: "Any authenticator app (Google Authenticator, Authy, Microsoft Authenticator)." },
  { id: "email", label: "Email code", tagline: "Basic option", helper: "We'll email you a code to enter — fastest to set up, weakest of the three." },
];

// Bare content only (no page chrome) — the caller wraps it in AuthShell for a full-screen
// mandatory flow, or drops it inline in an Account tab settings section for optional enrollment.
// `description` lets each caller supply its own contextual explanation (why enrollment is
// required/offered here specifically — admin login, hauler bid-gate, optional settings, etc.)
// rather than this component guessing at wording that fits every caller.
// `excludeEmail`: admin login-MFA needs a real aal2-capable factor — email code can never produce
// one (see the 2FA-methods migration), so admin enrollment never offers it, regardless of the
// admin-configurable allowed-methods list.
export function MfaEnrollment({ supabase, mandatory, excludeEmail, description, onComplete, onCancel }) {
  const [step, setStep] = useState("loading"); // loading | menu | totp-verify | passkey | email-request | email-verify | recovery
  const [allowedMethods, setAllowedMethods] = useState(["passkey", "totp", "email"]);
  const [enrolled, setEnrolled] = useState({ totp: false, passkey: false, email: false });
  const [factor, setFactor] = useState(null); // { id, totp: { qr_code, secret } }
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null);
  const [acked, setAcked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function refreshEnrolled() {
    const [totpFactors, webauthnFactors, hasEmail] = await Promise.all([
      listVerifiedTotpFactors(supabase), listVerifiedWebauthnFactors(supabase), hasEmailMfaFactor(supabase),
    ]);
    setEnrolled({ totp: totpFactors.length > 0, passkey: webauthnFactors.length > 0, email: hasEmail });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [methods] = await Promise.all([loadAllowedMfaMethods(supabase), refreshEnrolled()]);
        if (cancelled) return;
        setAllowedMethods(excludeEmail ? methods.filter(m => m !== "email") : methods);
      } catch (e) {
        if (!cancelled) setError(e.message || "Could not load two-factor options.");
      }
      if (!cancelled) setStep("menu");
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startTotp() {
    setError("");
    setLoading(true);
    try {
      // Clean up any abandoned, never-verified factor from a prior attempt before starting fresh.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.totp || []) {
        if (f.status !== "verified") await unenrollFactor(supabase, f.id);
      }
      const data = await enrollTotp(supabase);
      setFactor(data);
      setStep("totp-verify");
    } catch (e) {
      setError(e.message || "Could not start enrollment.");
    }
    setLoading(false);
  }

  async function submitTotpCode() {
    setError("");
    if (!code.trim()) { setError("Enter the 6-digit code from your authenticator app."); return; }
    setLoading(true);
    try {
      await challengeAndVerify(supabase, factor.id, code.trim());
      const generated = await generateRecoveryCodes(supabase);
      setCodes(generated);
      setStep("recovery");
    } catch (e) {
      setError(e.message || "That code didn't match — try again.");
    }
    setLoading(false);
  }

  async function startPasskey() {
    setError("");
    setLoading(true);
    try {
      await enrollPasskey(supabase);
      const generated = await generateRecoveryCodes(supabase);
      setCodes(generated);
      setStep("recovery");
    } catch (e) {
      setError(e.message || "Could not set up your passkey — your device or browser may not support it.");
    }
    setLoading(false);
  }

  async function startEmail() {
    setError("");
    setLoading(true);
    try {
      await startEmailMfaEnrollment(supabase);
      setStep("email-verify");
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
      const generated = await verifyEmailMfaCode(supabase, code.trim());
      setCodes(generated);
      setStep("recovery");
    } catch (e) {
      setError(e.message || "That code didn't match — try again.");
    }
    setLoading(false);
  }

  async function removeMethod(id) {
    setError("");
    setLoading(true);
    try {
      if (id === "totp") {
        const factors = await listVerifiedTotpFactors(supabase);
        for (const f of factors) await unenrollFactor(supabase, f.id);
      } else if (id === "passkey") {
        const factors = await listVerifiedWebauthnFactors(supabase);
        for (const f of factors) await unenrollFactor(supabase, f.id);
      } else if (id === "email") {
        await removeEmailMfaFactor(supabase);
      }
      await refreshEnrolled();
    } catch (e) {
      setError(e.message || "Could not remove this method.");
    }
    setLoading(false);
  }

  if (step === "loading") return null;

  if (step === "menu") {
    return (
      <div>
        <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 16 }}>
          {description || "Choose a method to set up two-factor authentication."}
        </div>
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <div style={{ display: "grid", gap: 10, marginBottom: 14 }}>
          {METHODS.filter(m => allowedMethods.includes(m.id)).map(m => (
            <div key={m.id} style={{ border: `1.5px solid ${C.line}`, borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{m.label}</span>
                  <Badge color={m.id === "passkey" ? C.teal : m.id === "totp" ? C.gray : C.amber}
                    bg={m.id === "passkey" ? C.tealLight : m.id === "totp" ? C.grayLight : C.amberLight}>{m.tagline}</Badge>
                </div>
                {enrolled[m.id] && <Badge color={C.teal} bg={C.tealLight}>✓ Enrolled</Badge>}
              </div>
              <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 10 }}>{m.helper}</div>
              {enrolled[m.id] ? (
                <Btn size="sm" full={false} variant="ghost" disabled={loading} onClick={() => removeMethod(m.id)}>Remove</Btn>
              ) : (
                <Btn size="sm" full={false} disabled={loading || (m.id === "passkey" && !browserSupportsPasskeys())}
                  onClick={m.id === "passkey" ? startPasskey : m.id === "totp" ? startTotp : startEmail}>
                  {loading ? "…" : m.id === "passkey" && !browserSupportsPasskeys() ? "Not supported on this device" : "Set up"}
                </Btn>
              )}
            </div>
          ))}
        </div>
        {mandatory && !Object.values(enrolled).some(Boolean) && (
          <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 10 }}>Set up at least one method above to continue.</div>
        )}
        {mandatory && Object.values(enrolled).some(Boolean) && onComplete && (
          <Btn onClick={onComplete} size="lg">Continue</Btn>
        )}
        {!mandatory && onCancel && (
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
            textDecoration: "underline", marginTop: 4, display: "block",
          }}>Close</button>
        )}
      </div>
    );
  }

  if (step === "totp-verify") {
    return (
      <div>
        <div style={{ fontSize: 13, color: C.ink, marginBottom: 12 }}>Scan this QR code with your authenticator app:</div>
        <div
          style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 12, display: "flex", justifyContent: "center" }}
          dangerouslySetInnerHTML={{ __html: factor.totp.qr_code }}
        />
        <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 16, wordBreak: "break-all" }}>
          Can't scan it? Enter this code manually: <strong style={{ fontFamily: "monospace" }}>{factor.totp.secret}</strong>
        </div>
        <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" required />
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <Btn onClick={submitTotpCode} disabled={loading} size="lg">{loading ? "Verifying…" : "Verify & continue"}</Btn>
        <button onClick={() => { setStep("menu"); setError(""); }} style={{
          background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
          textDecoration: "underline", marginTop: 14, display: "block",
        }}>Back</button>
      </div>
    );
  }

  if (step === "email-verify") {
    return (
      <div>
        <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 16 }}>
          We sent a 6-digit code to your email — enter it below. It expires in 10 minutes.
        </div>
        <Field label="6-digit code" value={code} onChange={setCode} placeholder="123456" required />
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <Btn onClick={submitEmailCode} disabled={loading} size="lg">{loading ? "Verifying…" : "Verify & continue"}</Btn>
        <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
          <button onClick={startEmail} disabled={loading} style={{
            background: "none", border: "none", color: C.teal, fontSize: 12.5, cursor: "pointer", fontWeight: 600,
          }}>Resend code</button>
          <button onClick={() => { setStep("menu"); setCode(""); setError(""); }} style={{
            background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer", textDecoration: "underline",
          }}>Back</button>
        </div>
      </div>
    );
  }

  // step === "recovery"
  return (
    <div>
      <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 12 }}>
        Save these one-time backup codes somewhere safe. Each one can be used once to sign in if you
        lose access to this method.
      </div>
      <div style={{
        background: C.sand, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 16,
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontFamily: "monospace", fontSize: 13.5, color: C.ink,
      }}>
        {codes.map((c) => <div key={c}>{c}</div>)}
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: C.ink, cursor: "pointer", marginBottom: 16, fontFamily: sans }}>
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} style={{ marginTop: 2 }} />
        I've saved these codes in a safe place.
      </label>
      <Btn onClick={onComplete} disabled={!acked} size="lg">Done</Btn>
    </div>
  );
}
