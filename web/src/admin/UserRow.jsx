import { useState } from "react";
import { C, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Avatar, Btn } from "../ui/Primitives";
import {
  updateUserProfile, setUserActive, sendPasswordReset, deleteUser,
  adminSuspendUser, adminRestoreUser, adminSetBiddingRestricted, adminSetPostingRestricted,
} from "./data";
import { tierName } from "../membership";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { UserReviewPanel } from "./UserReviewPanel";

export function userDisplayName(u) {
  return u.role === "customer" ? u.name : (u.business_name || u.name);
}

export function UserRow({ user: u, onEdit, onChanged, setToast, readOnly, session }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingAdminRole, setConfirmingAdminRole] = useState(false);
  const [working, setWorking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stepUpAction, setStepUpAction] = useState(null); // null | "deactivate" | "delete" | "suspend" | "restrict"
  const [sendingReset, setSendingReset] = useState(false);
  const [showReview, setShowReview] = useState(false);

  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [suspending, setSuspending] = useState(false);
  const [confirmingRestrict, setConfirmingRestrict] = useState(false);
  const [restrictReason, setRestrictReason] = useState("");
  const [togglingRestrict, setTogglingRestrict] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleSendPasswordReset() {
    setSendingReset(true);
    try {
      await sendPasswordReset(u.email);
      setToast(`Password reset email sent to ${displayName}.`);
    } catch (e) {
      setToast(e.message || "Could not send password reset email.");
    }
    setSendingReset(false);
  }

  async function toggleActive() {
    setWorking(true);
    try {
      await setUserActive(u.id, !u.active);
      setToast(u.active ? `${displayName} deactivated.` : `${displayName} reactivated.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update account status.");
    }
    setWorking(false);
    setConfirming(false);
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteUser(u.id);
      setToast(`${displayName} deleted.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not delete this account.");
    }
    setDeleting(false);
    setConfirmingDelete(false);
  }

  async function doSuspendOrRestore() {
    setSuspending(true);
    try {
      if (u.status === "suspended") {
        await adminRestoreUser(u.id);
        setToast(`${displayName} restored to active.`);
      } else {
        await adminSuspendUser(u.id, suspendReason.trim());
        setToast(`${displayName} suspended.`);
      }
      setSuspendReason("");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update suspension status.");
    }
    setSuspending(false);
    setConfirmingSuspend(false);
  }

  const isRestricted = u.role === "hauler" ? u.bidding_restricted : u.posting_restricted;

  async function doToggleRestrict() {
    setTogglingRestrict(true);
    try {
      const next = !isRestricted;
      if (u.role === "hauler") await adminSetBiddingRestricted(u.id, next, next ? restrictReason.trim() : null);
      else await adminSetPostingRestricted(u.id, next, next ? restrictReason.trim() : null);
      setToast(next
        ? `${displayName} is now blocked from ${u.role === "hauler" ? "bidding" : "posting"}.`
        : `${displayName} can ${u.role === "hauler" ? "bid" : "post"} again.`);
      setRestrictReason("");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update this restriction.");
    }
    setTogglingRestrict(false);
    setConfirmingRestrict(false);
  }

  async function toggleAdminReadOnly() {
    setWorking(true);
    try {
      await updateUserProfile(u.id, { admin_read_only: !u.admin_read_only });
      setToast(u.admin_read_only ? `${displayName} is now a full admin.` : `${displayName} is now view-only.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update admin access.");
    }
    setWorking(false);
    setConfirmingAdminRole(false);
  }

  const displayName = userDisplayName(u);

  return (
    <div style={{ border: `1px solid ${u.active ? C.line : C.red + "55"}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, background: u.active ? C.sand : C.redLight }}>
    <div
      onClick={() => setExpanded(v => !v)}
      style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 12px", cursor: "pointer" }}
    >
      <Avatar emoji={u.role === "customer" ? "👤" : u.role === "hauler" ? "🚛" : "🛡️"} size={32} bg={u.role === "customer" ? C.sandWarm : C.tealLight} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>
          {displayName}
          {u.role === "hauler" && u.verified && <span title="Verified hauler" style={{ marginLeft: 6 }}>✓</span>}
        </div>
        <div style={{ fontSize: 11.5, color: C.gray }}>{u.email} · ZIP {u.zip || "—"} · joined {new Date(u.created_at).toLocaleDateString()}</div>
      </div>
      {!u.active && <Badge color={C.red} bg={C.redLight}>deactivated</Badge>}
      {u.status === "suspended" && <Badge color={C.amber} bg={C.amberLight}>suspended</Badge>}
      {u.status === "deletion_requested" && (
        <Badge color={C.red} bg={C.redLight}>
          deletion pending{u.deletion_scheduled_for ? ` (${Math.max(0, Math.ceil((new Date(u.deletion_scheduled_for) - new Date()) / 86400000))}d)` : ""}
        </Badge>
      )}
      {(u.status === "anonymized" || u.status === "deleted") && <Badge color={C.gray} bg={C.grayLight}>{u.status}</Badge>}
      {isRestricted && (
        <Badge color={C.amber} bg={C.amberLight}>{u.role === "hauler" ? "bidding blocked" : "posting blocked"}</Badge>
      )}
      {u.flagCounts?.active > 0 && (
        <Badge color={C.red} bg={C.redLight}>🚩 {u.flagCounts.active} flag{u.flagCounts.active === 1 ? "" : "s"}</Badge>
      )}
      {u.role === "hauler" && (
        <>
          <Badge color={u.license_active ? C.teal : C.red} bg={u.license_active ? C.tealLight : C.redLight}>license {u.license_active ? "✓" : "✗"}</Badge>
          <Badge color={u.insurance_active ? C.teal : C.red} bg={u.insurance_active ? C.tealLight : C.redLight}>insurance {u.insurance_active ? "✓" : "✗"}</Badge>
          <Badge color={C.pineDeep} bg={C.sandWarm}>{tierName(u.membership_tier)}</Badge>
        </>
      )}
      <Badge color={u.role === "customer" ? C.gray : C.teal} bg={u.role === "customer" ? C.grayLight : C.tealLight}>{u.role}</Badge>
      {u.role === "admin" && u.super_admin && (
        <Badge color={C.pineDeep} bg={C.sandWarm}>👑 super admin</Badge>
      )}
      {u.role === "admin" && !u.super_admin && (
        <Badge color={u.admin_read_only ? C.amber : C.teal} bg={u.admin_read_only ? C.amberLight : C.tealLight}>
          {u.admin_read_only ? "view-only" : "full admin"}
        </Badge>
      )}
      <span style={{ fontSize: 13, color: C.gray, flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
    </div>
    {expanded && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "0 12px 12px 12px" }}>
      {!readOnly && <Btn size="sm" full={false} variant="ghost" onClick={() => onEdit(u)}>Edit</Btn>}
      {!readOnly && u.role === "admin" && !u.super_admin && (
        confirmingAdminRole ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: C.gray }}>{u.admin_read_only ? "Make full admin?" : "Make view-only?"}</span>
            <Btn size="sm" full={false} variant="teal" disabled={working} onClick={toggleAdminReadOnly}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingAdminRole(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingAdminRole(true)}>
            {u.admin_read_only ? "Make full admin" : "Make view-only"}
          </Btn>
        )
      )}
      {u.role !== "admin" && (
        <Btn size="sm" full={false} variant="ghost" onClick={() => setShowReview(true)}>Review</Btn>
      )}
      {!readOnly && u.role !== "admin" && (
        <Btn size="sm" full={false} variant="ghost" disabled={sendingReset} onClick={handleSendPasswordReset}>
          {sendingReset ? "Sending…" : "Reset passcode"}
        </Btn>
      )}
      {!readOnly && u.role !== "admin" && (
        confirming ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: C.gray }}>{u.active ? "Deactivate?" : "Reactivate?"}</span>
            <Btn size="sm" full={false} variant={u.active ? "danger" : "teal"} disabled={working} onClick={() => setStepUpAction("deactivate")}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirming(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant={u.active ? "danger" : "teal"} onClick={() => setConfirming(true)}>
            {u.active ? "Deactivate" : "Reactivate"}
          </Btn>
        )
      )}
      {!readOnly && u.role !== "admin" && (
        confirmingDelete ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: C.gray }}>Delete permanently?</span>
            <Btn size="sm" full={false} variant="danger" disabled={deleting} onClick={() => setStepUpAction("delete")}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingDelete(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant="danger" onClick={() => setConfirmingDelete(true)}>Delete</Btn>
        )
      )}
      {!readOnly && u.role !== "admin" && u.status !== "deletion_requested" && u.status !== "anonymized" && u.status !== "deleted" && (
        confirmingSuspend ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {u.status !== "suspended" && (
              <input value={suspendReason} onChange={e => setSuspendReason(e.target.value)} placeholder="Reason (required)"
                style={{ border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "6px 10px", fontSize: 12, minWidth: 140 }} />
            )}
            <span style={{ fontSize: 11.5, color: C.gray }}>{u.status === "suspended" ? "Restore this account?" : "Suspend this account?"}</span>
            <Btn size="sm" full={false} variant={u.status === "suspended" ? "teal" : "danger"} disabled={suspending || (u.status !== "suspended" && !suspendReason.trim())}
              onClick={() => setStepUpAction("suspend")}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingSuspend(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant={u.status === "suspended" ? "teal" : "danger"} onClick={() => setConfirmingSuspend(true)}>
            {u.status === "suspended" ? "Restore" : "Suspend"}
          </Btn>
        )
      )}
      {!readOnly && (u.role === "hauler" || u.role === "customer") && (
        confirmingRestrict ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {!isRestricted && (
              <input value={restrictReason} onChange={e => setRestrictReason(e.target.value)} placeholder="Reason (required)"
                style={{ border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "6px 10px", fontSize: 12, minWidth: 140 }} />
            )}
            <span style={{ fontSize: 11.5, color: C.gray }}>
              {isRestricted ? `Allow ${u.role === "hauler" ? "bidding" : "posting"} again?` : `Block ${u.role === "hauler" ? "bidding" : "posting"}?`}
            </span>
            <Btn size="sm" full={false} variant={isRestricted ? "teal" : "danger"} disabled={togglingRestrict || (!isRestricted && !restrictReason.trim())}
              onClick={() => setStepUpAction("restrict")}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingRestrict(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant={isRestricted ? "teal" : "ghost"} onClick={() => setConfirmingRestrict(true)}>
            {isRestricted ? `Allow ${u.role === "hauler" ? "bidding" : "posting"}` : `Block ${u.role === "hauler" ? "bidding" : "posting"}`}
          </Btn>
        )
      )}
      </div>
    )}
      {stepUpAction && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => {
            const action = stepUpAction;
            setStepUpAction(null);
            if (action === "deactivate") toggleActive();
            else if (action === "delete") handleDelete();
            else if (action === "suspend") doSuspendOrRestore();
            else if (action === "restrict") doToggleRestrict();
          }}
          onCancel={() => setStepUpAction(null)}
        />
      )}
      {showReview && (
        <UserReviewPanel user={u} onClose={() => setShowReview(false)} onFlagsChanged={onChanged} setToast={setToast} readOnly={readOnly} session={session} />
      )}
    </div>
  );
}
