import { useState } from "react";
import { C, serif } from "../theme";
import { Btn, Field, ErrorMsg } from "../ui/Primitives";
import { updateUserProfile } from "./data";

export function EditUserModal({ user, onClose, onSaved, setToast }) {
  const [name, setName] = useState(user.name || "");
  const [businessName, setBusinessName] = useState(user.business_name || "");
  const [zip, setZip] = useState(user.zip || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [verified, setVerified] = useState(!!user.verified);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    setError("");
    if (!name.trim()) { setError("Name is required."); return; }
    if (user.role === "hauler" && !businessName.trim()) { setError("Business name is required."); return; }

    setSaving(true);
    try {
      const fields = { name: name.trim(), zip: zip.trim(), phone: phone.trim() || null };
      if (user.role === "hauler") {
        fields.business_name = businessName.trim();
        fields.verified = verified;
      }
      await updateUserProfile(user.id, fields);
      setToast("User updated.");
      onSaved();
    } catch (e) {
      setError(e.message || "Could not save changes.");
    }
    setSaving(false);
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(22,35,45,0.55)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{ background: C.paper, borderRadius: 16, padding: 24, width: "100%", maxWidth: 420, border: `1px solid ${C.line}` }}>
        <div style={{ fontFamily: serif, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>Edit user</div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>{user.email} · {user.role}</div>

        {user.role === "hauler" && (
          <Field label="Business name" value={businessName} onChange={setBusinessName} required />
        )}
        <Field label={user.role === "hauler" ? "Contact name" : "Full name"} value={name} onChange={setName} required />
        <Field label="ZIP code" value={zip} onChange={setZip} />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="(optional)" />

        {user.role === "hauler" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />
            Verified hauler
          </label>
        )}

        {error && <ErrorMsg>{error}</ErrorMsg>}

        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Btn>
        </div>
      </div>
    </div>
  );
}
