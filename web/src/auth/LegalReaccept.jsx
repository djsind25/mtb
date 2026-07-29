import { useState } from "react";
import { C } from "../theme";
import { Btn, ErrorMsg } from "../ui/Primitives";
import { AuthShell } from "./AuthShell";
import { TermsAgreement } from "./TermsAgreement";
import { recordLegalAcceptance } from "../lib/legal";

// Shown when finishLogin's needsLegalReaccept check comes back true — either this account
// predates the acceptance-tracking feature entirely, or a version bump happened since they last
// accepted. Recording here creates a new row without touching any prior acceptance history.
export function LegalReaccept({ supabase, onDone, onBack }) {
  const [agreed, setAgreed] = useState(false);
  const [agreedToMonitoring, setAgreedToMonitoring] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleContinue() {
    setError("");
    if (!agreed) { setError("You must agree to continue."); return; }
    if (!agreedToMonitoring) { setError("You must acknowledge chat monitoring to continue."); return; }
    setLoading(true);
    try {
      await recordLegalAcceptance(supabase);
      onDone();
    } catch (e) {
      setError(e.message || "Could not record your acceptance.");
    }
    setLoading(false);
  }

  return (
    <AuthShell title="Terms of Service & Privacy Policy" subtitle="Please review and accept to continue" onBack={onBack}>
      <p style={{ fontSize: 13, color: C.gray, marginBottom: 14, lineHeight: 1.6 }}>
        Please review and accept our Terms of Service and Privacy Policy to keep using MyTrashBid.
      </p>
      <TermsAgreement checked={agreed} onChange={setAgreed} monitoringChecked={agreedToMonitoring} onMonitoringChange={setAgreedToMonitoring} />
      {error && <ErrorMsg>{error}</ErrorMsg>}
      <Btn onClick={handleContinue} disabled={loading} size="lg">{loading ? "Saving…" : "Continue"}</Btn>
    </AuthShell>
  );
}
