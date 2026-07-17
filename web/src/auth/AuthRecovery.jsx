import { useState } from "react";
import { C } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { mapProfileToSession } from "../lib/session";
import { Field, Btn, ErrorMsg } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";

export function AuthRecovery({ onAuthed, onBack }) {
  const [passcode, setPasscode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    setError("");
    if (passcode.trim().length < 6) { setError("Passcode must be at least 6 characters."); return; }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: passcode.trim() });
    if (updateError) { setLoading(false); setError(updateError.message); return; }

    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setLoading(false);
    if (!profile) { setError("Could not load your account. Try logging in instead."); return; }
    onAuthed(mapProfileToSession(profile));
  }

  return (
    <AuthShell title="Set a new passcode" subtitle="You clicked a passcode reset link" onBack={onBack}>
      <Field label="New passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 6 characters" required hint="At least 6 characters." />
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <Btn onClick={handleSubmit} disabled={loading} size="lg">{loading ? "Saving…" : "Set passcode & continue"}</Btn>
    </AuthShell>
  );
}
