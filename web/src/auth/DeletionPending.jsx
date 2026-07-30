import { useState } from "react";
import { C, sans } from "../theme";
import { Btn, ErrorMsg } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";
import { StepUpChallenge } from "./StepUpChallenge";
import { cancelOwnPendingDeletion } from "../dashboard/data";
import { mapProfileToSession } from "../lib/session";

// Shown when finishLogin sees status === 'deletion_requested' — the account can still log in
// during its 30-day window, but lands here instead of the dashboard until the request is
// cancelled. Mirrors the LegalReaccept/MfaEnroll blocking-stage pattern already used in App.jsx.
export function DeletionPending({ supabase, session, onCancelled, onBack }) {
  const [showStepUp, setShowStepUp] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  async function doCancel(password) {
    setShowStepUp(false);
    setCancelling(true);
    setError("");
    try {
      await cancelOwnPendingDeletion(password);
      const { data: profile, error: profileError } = await supabase
        .from("profiles").select("*").eq("id", session.id).single();
      if (profileError) throw profileError;
      onCancelled(mapProfileToSession(profile));
    } catch (e) {
      setError(e.message || "Could not cancel the deletion request.");
      setCancelling(false);
    }
  }

  return (
    <AuthShell title="Account scheduled for deletion" subtitle="You can cancel this any time before the scheduled date" onBack={onBack}>
      <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.6, marginBottom: 16 }}>
        <p>
          Your account is scheduled to be permanently anonymized on{" "}
          <strong>
            {session.deletionScheduledFor ? new Date(session.deletionScheduledFor).toLocaleDateString() : "the scheduled date"}
          </strong>.
        </p>
        {session.deletionReason && (
          <p style={{ fontSize: 12.5, color: C.gray, fontStyle: "italic" }}>Reason given: "{session.deletionReason}"</p>
        )}
        <p>Until then, your account can't post jobs, place bids, or send messages.</p>
      </div>
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <Btn onClick={() => setShowStepUp(true)} disabled={cancelling} size="lg">
        {cancelling ? "Cancelling…" : "Cancel deletion, keep my account"}
      </Btn>
      <div style={{ fontSize: 11.5, color: C.gray, marginTop: 10, fontFamily: sans }}>
        Or use "← Back" above to sign out and leave the request in place.
      </div>
      {showStepUp && (
        <StepUpChallenge supabase={supabase} onVerified={doCancel} onCancel={() => setShowStepUp(false)} />
      )}
    </AuthShell>
  );
}
