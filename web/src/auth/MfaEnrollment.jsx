import { useState } from "react";
import { C, sans } from "../theme";
import { Btn, Field, ErrorMsg } from "../ui/Primitives";
import { listVerifiedTotpFactors, enrollTotp, challengeAndVerify, unenrollFactor, generateRecoveryCodes } from "../lib/mfa";

// Bare content only (no page chrome) — the caller wraps it in AuthShell for a full-screen
// mandatory flow, or drops it inline in an Account tab settings section for optional enrollment.
// `description` lets each caller supply its own contextual explanation (why enrollment is
// required/offered here specifically — admin login, hauler bid-gate, optional settings, etc.)
// rather than this component guessing at wording that fits every caller.
export function MfaEnrollment({ supabase, mandatory, description, onComplete, onCancel }) {
  const [step, setStep] = useState("start"); // start | verify | recovery
  const [factor, setFactor] = useState(null); // { id, totp: { qr_code, secret } }
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState(null);
  const [acked, setAcked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startEnroll() {
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
      setStep("verify");
    } catch (e) {
      setError(e.message || "Could not start enrollment.");
    }
    setLoading(false);
  }

  async function submitCode() {
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

  if (step === "start") {
    return (
      <div>
        <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 16 }}>
          {description || "Set it up with any authenticator app (Google Authenticator, Authy, Microsoft Authenticator)."}
        </div>
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <Btn onClick={startEnroll} disabled={loading} size="lg">{loading ? "Starting…" : "Enable two-factor authentication"}</Btn>
        {!mandatory && onCancel && (
          <button onClick={onCancel} style={{
            background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
            textDecoration: "underline", marginTop: 14, display: "block",
          }}>Cancel</button>
        )}
      </div>
    );
  }

  if (step === "verify") {
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
        <Btn onClick={submitCode} disabled={loading} size="lg">{loading ? "Verifying…" : "Verify & continue"}</Btn>
      </div>
    );
  }

  // step === "recovery"
  return (
    <div>
      <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 12 }}>
        Save these one-time backup codes somewhere safe. Each one can be used once to sign in if you
        lose access to your authenticator app.
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
