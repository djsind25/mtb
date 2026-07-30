import { useEffect, useState } from "react";
import { C, sans, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn, CenteredNote } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { userDisplayName } from "./UserRow";
import {
  loadAccountDeletionBlockers, adminCancelPendingDeletion, adminAnonymizeNow, processDueAccountDeletions,
} from "./data";

function QueueRow({ user, onChanged, setToast, readOnly }) {
  const [blockers, setBlockers] = useState(null);
  const [reason, setReason] = useState("");
  const [force, setForce] = useState(false);
  const [stepUp, setStepUp] = useState(null); // null | "cancel" | "anonymize"
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadAccountDeletionBlockers(user.id).then(b => { if (!cancelled) setBlockers(b); }).catch(() => { if (!cancelled) setBlockers([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const daysLeft = user.deletion_scheduled_for
    ? Math.ceil((new Date(user.deletion_scheduled_for) - new Date()) / 86400000)
    : null;
  const pastDue = daysLeft !== null && daysLeft <= 0;
  const hasBlockers = blockers && blockers.length > 0;

  async function doCancel() {
    setWorking(true);
    try {
      await adminCancelPendingDeletion(user.id, reason.trim() || null);
      setToast(`Cancelled the pending deletion for ${userDisplayName(user)}.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not cancel this deletion.");
    }
    setWorking(false);
  }

  async function doAnonymize() {
    setWorking(true);
    try {
      await adminAnonymizeNow(user.id, reason.trim(), force);
      setToast(`${userDisplayName(user)} has been anonymized.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not anonymize this account.");
    }
    setWorking(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${pastDue ? C.red + "66" : C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{userDisplayName(user)}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>{user.email} · {user.role}</div>
          {user.deletion_reason && <div style={{ fontSize: 12, color: C.ink, marginTop: 4, fontStyle: "italic" }}>"{user.deletion_reason}"</div>}
        </div>
        <Badge color={pastDue ? C.red : C.amber} bg={pastDue ? C.redLight : C.amberLight}>
          {pastDue ? "Past due" : `${daysLeft}d left`}
        </Badge>
      </div>

      {blockers === null && <CenteredNote>Checking blockers…</CenteredNote>}
      {hasBlockers && (
        <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12, color: C.red }}>
          {blockers.map((b, i) => <li key={i}>{b.message}</li>)}
        </ul>
      )}

      {!readOnly && (
        <>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (optional for cancel, required for anonymize)"
            style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, fontFamily: "inherit", marginBottom: 6 }} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <Btn size="sm" full={false} variant="ghost" disabled={working} onClick={() => setStepUp("cancel")}>Cancel deletion</Btn>
            {hasBlockers && (
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: C.gray }}>
                <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} /> force
              </label>
            )}
            <Btn size="sm" full={false} variant="danger" disabled={working || !reason.trim() || (hasBlockers && !force)} onClick={() => setStepUp("anonymize")}>
              Anonymize now
            </Btn>
          </div>
        </>
      )}

      {stepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => {
            const action = stepUp;
            setStepUp(null);
            if (action === "cancel") doCancel();
            else if (action === "anonymize") doAnonymize();
          }}
          onCancel={() => setStepUp(null)}
        />
      )}
    </div>
  );
}

function AuditRow({ entry }) {
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>{entry.action}</span>
        <span style={{ fontSize: 10.5, color: C.gray, fontFamily: sans }}>{new Date(entry.created_at).toLocaleString()}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray }}>
        {entry.targetName || "Unknown"}{entry.actorName ? ` · by ${entry.actorName}` : " · system"}
        {entry.previous_status && entry.new_status && ` · ${entry.previous_status} → ${entry.new_status}`}
      </div>
      {entry.reason && <div style={{ fontSize: 12, color: C.ink, marginTop: 4, fontStyle: "italic" }}>"{entry.reason}"</div>}
      {entry.override_used && <Badge color={C.red} bg={C.redLight}>override used</Badge>}
    </div>
  );
}

// Clones the CancellationRequestsTab shape: a pending queue (accounts in deletion_requested,
// nearest-scheduled first) plus an audit-history view and the manual due-deletion sweep trigger —
// process_due_account_deletions() is the same function an eventual background worker would call,
// just exposed here for on-demand use in this trimmed, no-worker pass.
export function AccountDeletionsTab({ queue, auditLog, onChanged, setToast, readOnly }) {
  const [view, setView] = useState("queue"); // "queue" | "audit"
  const [sweeping, setSweeping] = useState(false);

  async function runSweep() {
    setSweeping(true);
    try {
      await processDueAccountDeletions();
      setToast("Due-deletion sweep complete.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not run the sweep.");
    }
    setSweeping(false);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {[{ id: "queue", label: `Pending (${queue.length})` }, { id: "audit", label: "Audit history" }].map(v => (
            <button key={v.id} onClick={() => setView(v.id)} style={{
              background: view === v.id ? C.pine : C.paper, color: view === v.id ? C.paper : C.ink,
              border: `1px solid ${view === v.id ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
              fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}>{v.label}</button>
          ))}
        </div>
        {!readOnly && (
          <Btn size="sm" full={false} variant="ghost" disabled={sweeping} onClick={runSweep}>
            {sweeping ? "Running…" : "Run due-deletion sweep now"}
          </Btn>
        )}
      </div>

      {view === "queue" && (
        <div style={{ display: "grid", gap: 10 }}>
          {queue.length === 0 && <CenteredNote>No accounts pending deletion.</CenteredNote>}
          {queue.map(u => <QueueRow key={u.id} user={u} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />)}
        </div>
      )}

      {view === "audit" && (
        <div style={{ display: "grid", gap: 8 }}>
          {auditLog.length === 0 && <CenteredNote>No account-lifecycle events yet.</CenteredNote>}
          {auditLog.map(entry => <AuditRow key={entry.id} entry={entry} />)}
        </div>
      )}
    </div>
  );
}
