import { useEffect, useState } from "react";
import { C, sans, RADIUS, SHADOW_MD } from "../theme";
import { Badge, Btn, CenteredNote } from "../ui/Primitives";
import { userDisplayName } from "./UserRow";
import {
  loadUserFlags, flagUser, resolveUserFlag, loadUserChats, loadUserCancellationCount,
  loadAccountDeletionBlockers, adminStartDeletion, adminCancelPendingDeletion, adminAnonymizeNow,
} from "./data";
import { AdminChatViewer } from "./AdminChatViewer";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";

const REASON_LABELS = {
  circumvention: "Circumvention attempt",
  cancellation_pattern: "Cancellation pattern",
  other: "Other",
};

function timeAgo(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Combines two related admin review needs on one user: their manual flag history (this app's own
// admin_user_flags — distinct from the automatic per-message/per-job flag_type system that flags
// content as it's posted) and every chat thread they've been part of, so an admin investigating a
// pattern (repeat circumvention attempts, bids that keep falling through) doesn't have to jump
// between separate screens to build the picture.
export function UserReviewPanel({ user, onClose, onFlagsChanged, setToast, readOnly }) {
  const [flags, setFlags] = useState(null);
  const [chats, setChats] = useState(null);
  const [cancellationCount, setCancellationCount] = useState(null);
  const [reasonType, setReasonType] = useState("circumvention");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolvingId, setResolvingId] = useState(null);
  const [openChatId, setOpenChatId] = useState(null);

  const [blockers, setBlockers] = useState(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [overrideBlockers, setOverrideBlockers] = useState(false);
  const [forceAnonymize, setForceAnonymize] = useState(false);
  const [lifecycleStepUp, setLifecycleStepUp] = useState(null); // null | "start" | "cancel" | "anonymize"
  const [lifecycleWorking, setLifecycleWorking] = useState(false);

  const displayName = userDisplayName(user);

  async function reload() {
    const [f, c, cc, b] = await Promise.all([
      loadUserFlags(user.id), loadUserChats(user.id), loadUserCancellationCount(user.id),
      user.role === "admin" ? Promise.resolve([]) : loadAccountDeletionBlockers(user.id),
    ]);
    setFlags(f);
    setChats(c);
    setCancellationCount(cc);
    setBlockers(b);
  }

  useEffect(() => {
    let cancelled = false;
    reload().catch(() => { if (!cancelled) { setFlags([]); setChats([]); setBlockers([]); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  async function submitFlag() {
    setSubmitting(true);
    try {
      await flagUser(user.id, reasonType, note);
      setNote("");
      setToast("User flagged.");
      await reload();
      onFlagsChanged?.();
    } catch (e) {
      setToast(e.message || "Could not flag this user.");
    }
    setSubmitting(false);
  }

  async function handleResolve(flagId) {
    setResolvingId(flagId);
    try {
      await resolveUserFlag(flagId);
      await reload();
      onFlagsChanged?.();
    } catch (e) {
      setToast(e.message || "Could not resolve this flag.");
    }
    setResolvingId(null);
  }

  async function doStartDeletion() {
    setLifecycleWorking(true);
    try {
      await adminStartDeletion(user.id, lifecycleReason.trim(), overrideBlockers);
      setToast("Deletion started for this account.");
      setLifecycleReason("");
      setOverrideBlockers(false);
      await reload();
      onFlagsChanged?.();
    } catch (e) {
      setToast(e.message || "Could not start deletion.");
    }
    setLifecycleWorking(false);
  }

  async function doCancelLifecycleDeletion() {
    setLifecycleWorking(true);
    try {
      await adminCancelPendingDeletion(user.id, lifecycleReason.trim() || null);
      setToast("Pending deletion cancelled.");
      setLifecycleReason("");
      await reload();
      onFlagsChanged?.();
    } catch (e) {
      setToast(e.message || "Could not cancel the pending deletion.");
    }
    setLifecycleWorking(false);
  }

  async function doAnonymizeNow() {
    setLifecycleWorking(true);
    try {
      await adminAnonymizeNow(user.id, lifecycleReason.trim(), forceAnonymize);
      setToast("Account anonymized.");
      setLifecycleReason("");
      setForceAnonymize(false);
      await reload();
      onFlagsChanged?.();
    } catch (e) {
      setToast(e.message || "Could not anonymize this account.");
    }
    setLifecycleWorking(false);
  }

  const hasBlockers = blockers && blockers.length > 0;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: RADIUS.lg, boxShadow: SHADOW_MD, width: "100%", maxWidth: 560, maxHeight: "88vh", border: `1px solid ${C.line}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontFamily: sans, fontSize: 17, fontWeight: 700, color: C.pineDeep }}>{displayName}</div>
            <div style={{ fontSize: 12, color: C.gray, marginTop: 2 }}>
              {user.email} · {user.role}{cancellationCount != null && ` · ${cancellationCount} cancellation${cancellationCount === 1 ? "" : "s"} caused`}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {user.role !== "admin" && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Account lifecycle</div>
              <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 12px" }}>
                <div style={{ fontSize: 12.5, color: C.ink, marginBottom: 8 }}>
                  Status: <strong>{user.status || "active"}</strong>
                  {user.status === "deletion_requested" && user.deletion_scheduled_for && (
                    <> · scheduled {new Date(user.deletion_scheduled_for).toLocaleDateString()}</>
                  )}
                </div>
                {blockers === null && <CenteredNote>Checking blockers…</CenteredNote>}
                {hasBlockers && (
                  <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12, color: C.red }}>
                    {blockers.map((b, i) => <li key={i}>{b.message}</li>)}
                  </ul>
                )}
                {!readOnly && user.status !== "anonymized" && user.status !== "deleted" && (
                  <>
                    <input value={lifecycleReason} onChange={e => setLifecycleReason(e.target.value)} placeholder="Reason (required for destructive actions)"
                      style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12.5, fontFamily: "inherit", marginBottom: 6 }} />
                    {user.status === "deletion_requested" ? (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <Btn size="sm" full={false} variant="ghost" disabled={lifecycleWorking} onClick={() => setLifecycleStepUp("cancel")}>Cancel pending deletion</Btn>
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: C.gray }}>
                          <input type="checkbox" checked={forceAnonymize} onChange={e => setForceAnonymize(e.target.checked)} /> force
                        </label>
                        <Btn size="sm" full={false} variant="danger" disabled={lifecycleWorking || (hasBlockers && !forceAnonymize)} onClick={() => setLifecycleStepUp("anonymize")}>
                          Anonymize now
                        </Btn>
                      </div>
                    ) : (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {hasBlockers && (
                          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: C.gray }}>
                            <input type="checkbox" checked={overrideBlockers} onChange={e => setOverrideBlockers(e.target.checked)} /> override
                          </label>
                        )}
                        <Btn size="sm" full={false} variant="danger" disabled={lifecycleWorking || !lifecycleReason.trim() || (hasBlockers && !overrideBlockers)}
                          onClick={() => setLifecycleStepUp("start")}>
                          Start deletion
                        </Btn>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Flags</div>
          {flags === null && <CenteredNote>Loading…</CenteredNote>}
          {flags?.length === 0 && <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 14 }}>No flags on this user.</div>}
          {flags && flags.length > 0 && (
            <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
              {flags.map(f => (
                <div key={f.id} style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                    <Badge color={f.resolved_at ? C.gray : C.red} bg={f.resolved_at ? C.grayLight : C.redLight}>
                      {REASON_LABELS[f.reason_type] || f.reason_type}
                    </Badge>
                    <span style={{ fontSize: 10.5, color: C.gray, whiteSpace: "nowrap" }}>{timeAgo(f.created_at)}</span>
                  </div>
                  {f.note && <div style={{ fontSize: 13, color: C.ink, marginBottom: 6 }}>{f.note}</div>}
                  <div style={{ fontSize: 11, color: C.gray }}>
                    Flagged by {f.flaggedByName || "an admin"}
                    {f.resolved_at && ` · resolved by ${f.resolvedByName || "an admin"} on ${timeAgo(f.resolved_at)}`}
                  </div>
                  {!f.resolved_at && !readOnly && (
                    <Btn size="sm" full={false} variant="ghost" disabled={resolvingId === f.id} onClick={() => handleResolve(f.id)}>
                      {resolvingId === f.id ? "Resolving…" : "Mark resolved"}
                    </Btn>
                  )}
                </div>
              ))}
            </div>
          )}

          {!readOnly && (
            <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 12px", marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Flag this user</div>
              <select value={reasonType} onChange={e => setReasonType(e.target.value)} style={{
                width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6,
                padding: "6px 8px", fontSize: 12.5, fontFamily: "inherit", marginBottom: 6,
              }}>
                <option value="circumvention">Circumvention attempt</option>
                <option value="cancellation_pattern">Cancellation pattern</option>
                <option value="other">Other</option>
              </select>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value.slice(0, 500))}
                placeholder="Optional note — what did you notice?"
                rows={2}
                style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "7px 10px", fontSize: 12.5, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 6 }}
              />
              <Btn size="sm" full={false} disabled={submitting} onClick={submitFlag}>{submitting ? "Flagging…" : "Flag user"}</Btn>
            </div>
          )}

          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Chat history</div>
          {chats === null && <CenteredNote>Loading…</CenteredNote>}
          {chats?.length === 0 && <div style={{ fontSize: 12.5, color: C.gray }}>No chats yet.</div>}
          {chats && chats.length > 0 && (
            <div style={{ display: "grid", gap: 6 }}>
              {chats.map(c => (
                <button key={c.id} onClick={() => setOpenChatId(c.id)} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
                  background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 12px",
                  cursor: "pointer", textAlign: "left", fontFamily: "inherit", width: "100%",
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{c.jobTitle || "Untitled job"}</div>
                    <div style={{ fontSize: 11, color: C.gray }}>
                      with {c.otherPartyName || "unknown"} · <span style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums" }}>{timeAgo(c.created_at)}</span>
                      {c.superseded_at && " · superseded"}
                    </div>
                  </div>
                  <span style={{ color: C.gray }}>→</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {openChatId && <AdminChatViewer chatId={openChatId} onClose={() => setOpenChatId(null)} />}

      {lifecycleStepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => {
            const action = lifecycleStepUp;
            setLifecycleStepUp(null);
            if (action === "start") doStartDeletion();
            else if (action === "cancel") doCancelLifecycleDeletion();
            else if (action === "anonymize") doAnonymizeNow();
          }}
          onCancel={() => setLifecycleStepUp(null)}
        />
      )}
    </div>
  );
}
