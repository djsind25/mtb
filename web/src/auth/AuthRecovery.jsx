import { useEffect, useState } from "react";
import { C } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { mapProfileToSession } from "../lib/session";
import { passcodeError, PASSCODE_HINT } from "../lib/passcode";
import { Field, Btn, ErrorMsg, CenteredNote } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";
import { StepUpChallenge } from "./StepUpChallenge";
import { listVerifiedTotpFactors } from "../lib/mfa";

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
  // A recovery-link session is only ever AAL1, but Supabase's own auth.updateUser() refuses to
  // change the password when the account has a verified MFA factor unless the session is already
  // AAL2. Only require the step-up when a factor actually exists — StepUpChallenge falls back to
  // "re-enter your current password" when there's no factor, which would be exactly backwards here
  // (the whole reason someone is on this screen is that they don't have their current password).
  const [needsStepUp, setNeedsStepUp] = useState(null); // null = checking, else boolean
  const [stepUpVerified, setStepUpVerified] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSessionState(session ? "ok" : "missing");
    });
  }, []);

  useEffect(() => {
    if (sessionState !== "ok") return;
    listVerifiedTotpFactors(supabase)
      .then((factors) => setNeedsStepUp(factors.length > 0))
      .catch(() => setNeedsStepUp(false)); // fail open to the plain password form rather than block the reset entirely
  }, [sessionState]);

  async function handleSubmit() {
    setError("");
    const pcError = passcodeError(passcode);
    if (pcError) { setError(pcError); return; }

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
      {sessionState === "checking" || needsStepUp === null ? (
        <CenteredNote>Checking your link…</CenteredNote>
      ) : needsStepUp && !stepUpVerified ? (
        <StepUpChallenge supabase={supabase} onVerified={() => setStepUpVerified(true)} onCancel={onBack} />
      ) : (
        <>
          <Field label="New passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 8 characters" required hint={PASSCODE_HINT} />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleSubmit} disabled={loading} size="lg">{loading ? "Saving…" : "Set passcode & continue"}</Btn>
        </>
      )}
    </AuthShell>
  );
}
