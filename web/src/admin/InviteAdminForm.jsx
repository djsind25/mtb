import { useState } from "react";
import { C, RADIUS, SHADOW_SM, fullDateLabel } from "../theme";
import { Btn, Field, Badge } from "../ui/Primitives";
import { createAdminInvite, cancelAdminInvite } from "./data";

export function InviteAdminForm({ onChanged, setToast, territories = [] }) {
  const [email, setEmail] = useState("");
  const [adminReadOnly, setAdminReadOnly] = useState(false);
  const [territoryId, setTerritoryId] = useState("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!email.trim()) { setToast("Enter an email address."); return; }
    setSending(true);
    try {
      await createAdminInvite(email.trim(), adminReadOnly, territoryId || null);
      setToast(`Invite sent to ${email.trim()}.`);
      setEmail("");
      setAdminReadOnly(false);
      setTerritoryId("");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not send invite.");
    }
    setSending(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>Invite a new admin</div>
      <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="new-admin@example.com" />
      <div style={{ display: "flex", gap: 14, marginBottom: 14, fontSize: 13 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="radio" name="adminInviteType" checked={!adminReadOnly} onChange={() => setAdminReadOnly(false)} />
          Full admin
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="radio" name="adminInviteType" checked={adminReadOnly} onChange={() => setAdminReadOnly(true)} />
          View-only admin
        </label>
      </div>
      {territories.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Territory (optional)</label>
          <select value={territoryId} onChange={e => setTerritoryId(e.target.value)} style={{
            width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm,
            padding: "8px 10px", fontSize: 13, fontFamily: "inherit", color: C.ink, background: C.paper,
          }}>
            <option value="">No territory (unrestricted)</option>
            {territories.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
      )}
      <Btn size="sm" full={false} onClick={send} disabled={sending}>{sending ? "Sending…" : "Send invite"}</Btn>
    </div>
  );
}

export function AdminInviteRow({ invite, onChanged, setToast, canCancel }) {
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const expired = new Date(invite.expires_at) <= new Date();

  async function cancel() {
    setWorking(true);
    try {
      await cancelAdminInvite(invite.id);
      setToast(`Invite to ${invite.email} cancelled.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not cancel invite.");
    }
    setWorking(false);
    setConfirming(false);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: `1px solid ${C.line}`, borderRadius: RADIUS.md }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.pineDeep }}>{invite.email}</div>
        <div style={{ fontSize: 11, color: C.gray }}>
          Invited by {invite.invitedByName || "—"} · {expired ? "expired" : `expires ${fullDateLabel(invite.expires_at)}`}
        </div>
      </div>
      <Badge color={invite.admin_read_only ? C.amber : C.teal} bg={invite.admin_read_only ? C.amberLight : C.tealLight}>
        {invite.admin_read_only ? "view-only" : "full admin"}
      </Badge>
      {canCancel && (
        confirming ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: C.gray }}>Cancel this invite?</span>
            <Btn size="sm" full={false} variant="danger" disabled={working} onClick={cancel}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirming(false)}>No</Btn>
          </div>
        ) : (
          <Btn size="sm" full={false} variant="danger" onClick={() => setConfirming(true)}>Cancel</Btn>
        )
      )}
    </div>
  );
}
