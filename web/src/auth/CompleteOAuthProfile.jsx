import { useState } from "react";
import { C, sans } from "../theme";
import { Field, Btn, ErrorMsg } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";
import { TermsAgreement } from "./TermsAgreement";
import { SmsAgreement } from "./SmsAgreement";
import { mapProfileToSession } from "../lib/session";
import { recordLegalAcceptance } from "../lib/legal";

// Shown once, right after a fresh Google (or later Apple) sign-in, for the fields OAuth
// providers never give us: role, ZIP, phone, business name. Detected upstream in App.jsx by
// profiles.zip === '' — the auto-create trigger's hardcoded default for any OAuth signup.
export function CompleteOAuthProfile({ supabase, profile, roleHint, onDone, onBack }) {
  const [role, setRole] = useState(roleHint === "customer" || roleHint === "hauler" ? roleHint : null);
  const [businessName, setBusinessName] = useState("");
  const [zip, setZip] = useState("");
  const [phone, setPhone] = useState("");
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [agreedToMonitoring, setAgreedToMonitoring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  if (!role) {
    return (
      <AuthShell title="One more step" subtitle="Which best describes you?" onBack={onBack}>
        <div style={{ display: "grid", gap: 12 }}>
          <RolePick icon="👤" title="I'm a customer" desc="Post a job or rent a dumpster" onClick={() => setRole("customer")} />
          <RolePick icon="🚛" title="I'm a hauler / dumpster rental business" desc="Bid on jobs, manage your profile" onClick={() => setRole("hauler")} />
        </div>
      </AuthShell>
    );
  }

  async function handleSubmit() {
    setError("");
    if (!zip.trim()) { setError("ZIP code is required."); return; }
    if (role === "hauler" && !businessName.trim()) { setError("Business name is required."); return; }
    if (role === "hauler" && !phone.trim()) { setError("Phone is required."); return; }
    if (!agreedToTerms) { setError("You must agree to the Terms of Service to continue."); return; }
    if (!agreedToMonitoring) { setError("You must acknowledge chat monitoring to continue."); return; }

    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc("complete_oauth_profile", {
      p_role: role,
      p_name: profile.name || "",
      p_business_name: role === "hauler" ? businessName.trim() : "",
      p_zip: zip.trim(),
      p_phone: phone.trim(),
      p_sms_consent: smsOptIn,
    });
    setLoading(false);
    if (rpcError) { setError(rpcError.message); return; }
    // Best-effort — see the matching comment in AuthForm.jsx's handleSignup.
    try { await recordLegalAcceptance(supabase); } catch { /* caught by the login-time check */ }
    onDone(mapProfileToSession(data));
  }

  return (
    <AuthShell
      title="One more step"
      subtitle={role === "hauler" ? "Set up your hauler account" : "Set up your account"}
      onBack={onBack}
    >
      {role === "hauler" && (
        <Field label="Business name" value={businessName} onChange={setBusinessName} placeholder="Capital City Haulers" required />
      )}
      <Field label={role === "hauler" ? "Primary service ZIP" : "ZIP code"} value={zip} onChange={setZip} placeholder="60491" required />
      <Field
        label="Phone" value={phone} onChange={setPhone} type="tel"
        placeholder={role === "hauler" ? "(555) 867-5309" : "(optional)"} required={role === "hauler"}
      />
      <SmsAgreement checked={smsOptIn} onChange={setSmsOptIn} />
      <TermsAgreement checked={agreedToTerms} onChange={setAgreedToTerms} monitoringChecked={agreedToMonitoring} onMonitoringChange={setAgreedToMonitoring} />
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <Btn onClick={handleSubmit} disabled={loading} size="lg">{loading ? "Saving…" : "Finish setting up"}</Btn>
    </AuthShell>
  );
}

function RolePick({ icon, title, desc, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 14, padding: "20px",
      display: "flex", alignItems: "center", gap: 14, cursor: "pointer", textAlign: "left", fontFamily: sans,
    }}>
      <div style={{ fontSize: 28 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.pineDeep, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.gray }}>{desc}</div>
      </div>
      <div style={{ color: C.gray }}>→</div>
    </button>
  );
}
