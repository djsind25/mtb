import { useEffect, useState } from "react";
import { C } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { mapProfileToSession } from "../lib/session";
import { Field, Btn, ErrorMsg, CenteredNote } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";

// A password-reset email link only *looks* like a recovery link from its URL shape
// (`#...type=recovery`) — that's not proof supabase-js actually turned it into a session. If the
// one-time token was already consumed before the user's real tap (a mail client's link-safety
// scanner pre-fetching it is the classic cause) or otherwise failed to establish a session,
// updateUser() below fails with a raw "Auth session missing!" that means nothing to a real user.
// Checking getSession() up front — and re-checking the same failure mode at submit time, in case
// the session dies in between — lets both cases show one clear "this link is dead, get a new one"
// state instead of a cryptic SDK error string.
function isSessionMissingError(err) {
  return err?.name === "AuthSessionMissingError" || /session.*missing/i.test(err?.message || "");
}

export function AuthRecovery({ onAuthed, onBack }) {
  const [passcode, setPasscode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sessionState, setSessionState] = useState("checking"); // checking | ok | missing

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSessionState(session ? "ok" : "missing");
    });
  }, []);

  async function handleSubmit() {
    setError("");
    if (passcode.trim().length < 6) { setError("Passcode must be at least 6 characters."); return; }

    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: passcode.trim() });
    if (updateError) {
      setLoading(false);
      if (isSessionMissingError(updateError)) { setSessionState("missing"); return; }
      setError(updateError.message);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    setLoading(false);
    if (!profile) { setError("Could not load your account. Try logging in instead."); return; }
    onAuthed(mapProfileToSession(profile));
  }

  if (sessionState === "missing") {
    return (
      <AuthShell title="Link expired" subtitle="This passcode reset link is no longer valid" onBack={onBack}>
        <CenteredNote>
          Reset links only work once and expire after a while — this one's already used up. Go back and request a new one.
        </CenteredNote>
        <Btn onClick={onBack} size="lg">Back to login</Btn>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set a new passcode" subtitle="You clicked a passcode reset link" onBack={onBack}>
      {sessionState === "checking" ? (
        <CenteredNote>Checking your link…</CenteredNote>
      ) : (
        <>
          <Field label="New passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 6 characters" required hint="At least 6 characters." />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleSubmit} disabled={loading} size="lg">{loading ? "Saving…" : "Set passcode & continue"}</Btn>
        </>
      )}
    </AuthShell>
  );
}
