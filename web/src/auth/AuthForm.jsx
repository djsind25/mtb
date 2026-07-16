import { useState } from "react";
import { C, sans } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { mapProfileToSession } from "../lib/session";
import { Field, Btn, ErrorMsg } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";
import { TermsAgreement } from "./TermsAgreement";

async function fetchProfile(userId) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
  if (error) return null;
  return data;
}

export function AuthForm({ role, onBack, onAuthed, setToast }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // shared
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  // customer signup
  const [name, setName] = useState("");
  const [zip, setZip] = useState("");
  // hauler signup
  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [serviceZip, setServiceZip] = useState("");

  // admin
  const [adminPass, setAdminPass] = useState("");
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  async function handleAdminLogin() {
    setError("");
    if (!email.trim() || !adminPass.trim()) { setError("Enter your email and passcode."); return; }
    setLoading(true);
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password: adminPass });
    if (authError) { setLoading(false); setError("Incorrect admin email or passcode."); return; }
    const profile = await fetchProfile(data.user.id);
    setLoading(false);
    if (!profile || profile.role !== "admin") {
      await supabase.auth.signOut();
      setError("This account does not have admin access.");
      return;
    }
    onAuthed(mapProfileToSession(profile));
  }

  async function handleLogin() {
    setError("");
    if (!email.trim() || !passcode.trim()) { setError("Enter your email and passcode."); return; }
    setLoading(true);
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password: passcode.trim() });
    if (authError) { setLoading(false); setError("Incorrect email or passcode."); return; }
    const profile = await fetchProfile(data.user.id);
    setLoading(false);
    if (!profile) { setError("No profile found for this account."); return; }
    if (profile.role !== role) {
      await supabase.auth.signOut();
      setError(`This account is registered as a ${profile.role}. Pick "${profile.role === "customer" ? "I'm a customer" : "I'm a hauler"}" instead.`);
      return;
    }
    if (!profile.active) {
      await supabase.auth.signOut();
      setError("This account has been deactivated. Contact support if you believe this is a mistake.");
      return;
    }
    onAuthed(mapProfileToSession(profile));
  }

  async function handleSignup() {
    setError("");
    if (role === "customer") {
      if (!name.trim() || !email.trim() || !passcode.trim() || !zip.trim()) { setError("Fill in all fields."); return; }
    } else {
      if (!businessName.trim() || !contactName.trim() || !email.trim() || !passcode.trim() || !serviceZip.trim()) { setError("Fill in all fields."); return; }
    }
    if (passcode.trim().length < 6) { setError("Passcode must be at least 6 characters."); return; }
    if (!agreedToTerms) { setError("You must agree to the Terms of Service to continue."); return; }

    setLoading(true);
    // Profile creation happens server-side via a trigger on auth.users (see the
    // auto_create_profile_on_signup migration) — it reads this metadata regardless of whether
    // email confirmation delays the session, so it can't be skipped by that timing the way a
    // client-side insert right here would be.
    const metadata = role === "customer"
      ? { role, name: name.trim(), zip: zip.trim() }
      : { role, name: contactName.trim(), business_name: businessName.trim(), zip: serviceZip.trim() };
    const { data, error: authError } = await supabase.auth.signUp({
      email: email.trim(), password: passcode.trim(), options: { data: metadata },
    });
    if (authError) { setLoading(false); setError(authError.message); return; }
    // Supabase doesn't return an explicit error for an already-registered email (anti-enumeration
    // protection) — an empty identities array is its documented signal that the account already exists.
    if (data.user && data.user.identities?.length === 0) {
      setLoading(false);
      setError("An account with this email already exists. Try logging in instead.");
      return;
    }
    setLoading(false);
    if (!data.session) {
      setError("Check your email to confirm your account, then log in.");
      return;
    }

    setToast(`Welcome to MyTrashBid, ${role === "customer" ? name.trim() : businessName.trim()}!`);
    onAuthed(mapProfileToSession({ id: data.user.id, role, email: email.trim(), ...metadata }));
  }

  if (role === "admin") {
    return (
      <AuthShell title="Admin login" subtitle="Restricted access" onBack={onBack}>
        <Field label="Admin email" value={email} onChange={setEmail} placeholder="admin@mytrashbid.com" />
        <Field label="Passcode" value={adminPass} onChange={setAdminPass} type="password" placeholder="••••••" />
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <Btn onClick={handleAdminLogin} disabled={loading} size="lg" variant="dark">{loading ? "Checking…" : "Enter dashboard"}</Btn>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={role === "customer" ? "Customer account" : "Hauler account"}
      subtitle={mode === "login" ? "Welcome back" : "Let's get you set up"}
      onBack={onBack}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 20, background: C.sandWarm, borderRadius: 14, padding: 3 }}>
        {["login", "signup"].map(m => (
          <button key={m} onClick={() => { setMode(m); setError(""); }} style={{
            flex: 1, padding: "8px", borderRadius: 10, border: "none", cursor: "pointer",
            background: mode === m ? C.paper : "transparent", fontWeight: 700, fontSize: 13,
            color: mode === m ? C.pineDeep : C.gray, fontFamily: sans,
          }}>{m === "login" ? "Log in" : "Sign up"}</button>
        ))}
      </div>

      {mode === "login" && (
        <>
          <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@email.com" required />
          <Field label="Passcode" value={passcode} onChange={setPasscode} type="password" placeholder="••••••" required />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleLogin} disabled={loading} size="lg">{loading ? "Checking…" : "Log in"}</Btn>
        </>
      )}

      {mode === "signup" && role === "customer" && (
        <>
          <Field label="Full name" value={name} onChange={setName} placeholder="Dave K." required />
          <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@email.com" required />
          <Field label="ZIP code" value={zip} onChange={setZip} placeholder="60491" required />
          <Field label="Create a passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 6 characters" required hint="At least 6 characters." />
          <TermsAgreement checked={agreedToTerms} onChange={setAgreedToTerms} />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleSignup} disabled={loading} size="lg">{loading ? "Creating account…" : "Create account"}</Btn>
        </>
      )}

      {mode === "signup" && role === "hauler" && (
        <>
          <Field label="Business name" value={businessName} onChange={setBusinessName} placeholder="Capital City Haulers" required />
          <Field label="Contact name" value={contactName} onChange={setContactName} placeholder="Jake Torres" required />
          <Field label="Business email" value={email} onChange={setEmail} type="email" placeholder="jake@capitalcityhaul.com" required />
          <Field label="Primary service ZIP" value={serviceZip} onChange={setServiceZip} placeholder="60491" required />
          <Field label="Create a passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 6 characters" required hint="At least 6 characters." />
          <TermsAgreement checked={agreedToTerms} onChange={setAgreedToTerms} />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleSignup} disabled={loading} size="lg">{loading ? "Creating account…" : "Apply as a hauler"}</Btn>
        </>
      )}
    </AuthShell>
  );
}
