import { useState } from "react";
import { C } from "../theme";
import { Badge, Avatar, Btn } from "../ui/Primitives";
import { updateUserProfile } from "./data";

export function UserRow({ user: u, onEdit, onChanged, setToast, readOnly }) {
  const [confirming, setConfirming] = useState(false);
  const [confirmingAdminRole, setConfirmingAdminRole] = useState(false);
  const [working, setWorking] = useState(false);

  async function toggleActive() {
    setWorking(true);
    try {
      await updateUserProfile(u.id, { active: !u.active, deactivated_at: u.active ? new Date().toISOString() : null });
      setToast(u.active ? `${displayName} deactivated.` : `${displayName} reactivated.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update account status.");
    }
    setWorking(false);
    setConfirming(false);
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

  const displayName = u.role === "customer" ? u.name : (u.business_name || u.name);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: `1px solid ${u.active ? C.line : C.red + "55"}`, borderRadius: 10, background: u.active ? "transparent" : C.redLight }}>
      <Avatar emoji={u.role === "customer" ? "👤" : u.role === "hauler" ? "🚛" : "🛡️"} size={32} bg={u.role === "customer" ? C.sandWarm : C.tealLight} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>
          {displayName}
          {u.role === "hauler" && u.verified && <span title="Verified hauler" style={{ marginLeft: 6 }}>✓</span>}
        </div>
        <div style={{ fontSize: 11.5, color: C.gray }}>{u.email} · ZIP {u.zip || "—"} · joined {new Date(u.created_at).toLocaleDateString()}</div>
      </div>
      {!u.active && <Badge color={C.red} bg={C.redLight}>deactivated</Badge>}
      {u.role === "hauler" && (
        <>
          <Badge color={u.license_active ? C.teal : C.red} bg={u.license_active ? C.tealLight : C.redLight}>license {u.license_active ? "✓" : "✗"}</Badge>
          <Badge color={u.insurance_active ? C.teal : C.red} bg={u.insurance_active ? C.tealLight : C.redLight}>insurance {u.insurance_active ? "✓" : "✗"}</Badge>
        </>
      )}
      <Badge color={u.role === "customer" ? C.gray : C.teal} bg={u.role === "customer" ? C.grayLight : C.tealLight}>{u.role}</Badge>
      {u.role === "admin" && (
        <Badge color={u.admin_read_only ? C.amber : C.teal} bg={u.admin_read_only ? C.amberLight : C.tealLight}>
          {u.admin_read_only ? "view-only" : "full admin"}
        </Badge>
      )}
      {!readOnly && <Btn size="sm" full={false} variant="ghost" onClick={() => onEdit(u)}>Edit</Btn>}
      {!readOnly && u.role === "admin" && (
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
      {!readOnly && u.role !== "admin" && (
        confirming ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: C.gray }}>{u.active ? "Deactivate?" : "Reactivate?"}</span>
            <Btn size="sm" full={false} variant={u.active ? "danger" : "teal"} disabled={working} onClick={toggleActive}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirming(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant={u.active ? "danger" : "teal"} onClick={() => setConfirming(true)}>
            {u.active ? "Deactivate" : "Reactivate"}
          </Btn>
        )
      )}
    </div>
  );
}
