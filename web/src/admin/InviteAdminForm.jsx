import { useState } from "react";
import { C } from "../theme";
import { Btn, Field, Badge } from "../ui/Primitives";
import { createAdminInvite, cancelAdminInvite } from "./data";

export function InviteAdminForm({ onChanged, setToast }) {
  const [email, setEmail] = useState("");
  const [adminReadOnly, setAdminReadOnly] = useState(false);
  const [sending, setSending] = useState(false);

  async function send() {
    if (!email.trim()) { setToast("Enter an email address."); return; }
    setSending(true);
    try {
      await createAdminInvite(email.trim(), adminReadOnly);
      setToast(`Invite sent to ${email.trim()}.`);
      setEmail("");
      setAdminReadOnly(false);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not send invite.");
    }
    setSending(false);
  }

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
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
      <Btn size="sm" full={false} onClick={send} disabled={sending}>{sending ? "Sending…" : "Send invite"}</Btn>
    </div>
  );
}

export function AdminInviteRow({ invite, onChanged, setToast, canCancel }) {
  const [working, setWorking] = useState(false);
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
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: `1px solid ${C.line}`, borderRadius: 10 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.pineDeep }}>{invite.email}</div>
        <div style={{ fontSize: 11, color: C.gray }}>
          Invited by {invite.invitedByName || "—"} · {expired ? "expired" : `expires ${new Date(invite.expires_at).toLocaleDateString()}`}
        </div>
      </div>
      <Badge color={invite.admin_read_only ? C.amber : C.teal} bg={invite.admin_read_only ? C.amberLight : C.tealLight}>
        {invite.admin_read_only ? "view-only" : "full admin"}
      </Badge>
      {canCancel && <Btn size="sm" full={false} variant="danger" disabled={working} onClick={cancel}>Cancel</Btn>}
    </div>
  );
}
