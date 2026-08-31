import { useState } from "react";
import { C, sans, nowStr, RADIUS, SHADOW_SM } from "../theme";
import { Btn, CenteredNote, Badge } from "../ui/Primitives";
import { releasePayout, setPayoutReleaseMode } from "./data";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { UserLink } from "./UserLink";

function Row({ payout, onChanged, setToast, readOnly, onViewUser }) {
  const [confirming, setConfirming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [showStepUp, setShowStepUp] = useState(false);

  async function confirmRelease() {
    setReleasing(true);
    try {
      await releasePayout(payout.id);
      setToast(`$${Number(payout.amount).toFixed(2)} released to ${payout.hauler_business_name || payout.hauler_name || "the hauler"}.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not release this payout.");
    }
    setReleasing(false);
    setConfirming(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{payout.job_title || "Job"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            <UserLink id={payout.customer_id} name={payout.customer_name} onViewUser={onViewUser} /> →{" "}
            <UserLink id={payout.hauler_id} name={payout.hauler_business_name || payout.hauler_name} onViewUser={onViewUser} />
          </div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>Completed {nowStr(payout.created_at)}</div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: C.pineDeep }}>${Number(payout.amount).toFixed(2)}</div>
          <div style={{ fontSize: 10.5, color: C.gray }}>hauler share</div>
        </div>
      </div>

      {readOnly ? (
        <Badge color={C.ember} bg={C.emberLight}>Awaiting release</Badge>
      ) : !confirming ? (
        <Btn full={false} onClick={() => setConfirming(true)}>Release funds</Btn>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" full={false} onClick={() => setConfirming(false)}>Cancel</Btn>
          <Btn full={false} disabled={releasing} onClick={() => setShowStepUp(true)}>
            {releasing ? "Releasing…" : `Yes, send $${Number(payout.amount).toFixed(2)}`}
          </Btn>
        </div>
      )}
      {showStepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => { setShowStepUp(false); confirmRelease(); }}
          onCancel={() => setShowStepUp(false)}
        />
      )}
    </div>
  );
}

export function PayoutsTab({ payouts, releaseMode, session, onChanged, setToast, readOnly, onViewUser }) {
  const [togglingMode, setTogglingMode] = useState(false);
  const isManual = releaseMode !== "automatic";
  const canEditMode = !readOnly && session.superAdmin;

  async function toggleMode() {
    setTogglingMode(true);
    try {
      await setPayoutReleaseMode(isManual ? "automatic" : "manual");
      setToast(isManual ? "Payouts now release automatically on completion." : "Payouts now require manual release.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not change this setting.");
    }
    setTogglingMode(false);
  }

  const total = payouts.reduce((sum, p) => sum + Number(p.amount), 0);

  return (
    <div>
      <div style={{
        background: isManual ? C.tealLight : C.grayLight, border: `1px solid ${isManual ? C.teal + "44" : C.line}`,
        borderRadius: RADIUS.md, padding: "12px 14px", marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>
          Release mode: {isManual ? "Manual — an admin releases each payout" : "Automatic — releases the moment a job completes"}
        </div>
        <div style={{ fontSize: 11.5, color: C.gray, marginTop: 3 }}>
          Super-admin-only setting. Switching this doesn't touch payouts already queued below.
        </div>
        {canEditMode && (
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" full={false} variant="ghost" disabled={togglingMode} onClick={toggleMode}>
              {togglingMode ? "Switching…" : isManual ? "Switch to automatic" : "Switch to manual"}
            </Btn>
          </div>
        )}
        {!canEditMode && !readOnly && (
          <div style={{ fontSize: 11, color: C.gray, marginTop: 8 }}>Only the super admin can change this.</div>
        )}
      </div>

      {payouts.length > 0 && (
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 10 }}>
          {payouts.length} pending, ${total.toFixed(2)} total
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {payouts.length === 0 && <CenteredNote>No payouts waiting on release.</CenteredNote>}
        {payouts.map(p => <Row key={p.id} payout={p} onChanged={onChanged} setToast={setToast} readOnly={readOnly} onViewUser={onViewUser} />)}
      </div>
    </div>
  );
}
