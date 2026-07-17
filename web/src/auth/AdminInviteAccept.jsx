import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { mapProfileToSession } from "../lib/session";
import { Field, Btn, ErrorMsg } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";

export function AdminInviteAccept({ token, onAuthed, onBack }) {
  const [status, setStatus] = useState("checking"); // checking | invalid | ready | submitting
  const [invite, setInvite] = useState(null);
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: rpcError } = await supabase.rpc("check_admin_invite", { p_token: token });
      if (cancelled) return;
      const row = data?.[0];
      if (rpcError || !row) { setStatus("invalid"); return; }
      setInvite(row);
      setStatus("ready");
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit() {
    setError("");
    if (!name.trim()) { setError("Enter your name."); return; }
    if (passcode.trim().length < 6) { setError("Passcode must be at least 6 characters."); return; }

    setStatus("submitting");
    // handle_new_user() only clamps an *unrecognized* role to 'customer' — a missing role key
    // isn't caught by that check (`null not in (...)` is null, not true, in SQL), so it must be
    // passed explicitly here. accept_admin_invite() promotes this straight to admin right after.
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: invite.email, password: passcode.trim(), options: { data: { role: "customer", name: name.trim() } },
    });
    if (signUpError) { setStatus("ready"); setError(signUpError.message); return; }
    if (data.user && data.user.identities?.length === 0) {
      setStatus("ready");
      setError("An account with this email already exists. Log in instead.");
      return;
    }
    if (!data.session) {
      setStatus("ready");
      setError("Check your email to confirm your account, then try this invite link again.");
      return;
    }

    const { data: accepted, error: acceptError } = await supabase.rpc("accept_admin_invite", { p_token: token });
    if (acceptError || !accepted) {
      setStatus("ready");
      setError("Could not finish setting up your admin account. Contact whoever invited you.");
      return;
    }

    const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
    onAuthed(mapProfileToSession(profile));
  }

  if (status === "checking") {
    return <AuthShell title="Admin invite" subtitle="Checking your invite…" onBack={onBack} />;
  }

  if (status === "invalid") {
    return (
      <AuthShell title="Admin invite" subtitle="This link isn't valid" onBack={onBack}>
        <ErrorMsg>This invite link is invalid, expired, or has already been used.</ErrorMsg>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set up your admin account"
      subtitle={`You've been invited as a ${invite.admin_read_only ? "view-only" : "full"} admin`}
      onBack={onBack}
    >
      <Field label="Email" value={invite.email} onChange={() => {}} type="email" />
      <Field label="Full name" value={name} onChange={setName} placeholder="Jane Doe" required />
      <Field label="Create a passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 6 characters" required hint="At least 6 characters." />
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <Btn onClick={handleSubmit} disabled={status === "submitting"} size="lg">
        {status === "submitting" ? "Setting up…" : "Create admin account"}
      </Btn>
    </AuthShell>
  );
}
