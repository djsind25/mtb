import { useState } from "react";
import { C, sans } from "../theme";
import { Btn, Field, ErrorMsg } from "../ui/Primitives";
import { updateUserProfile, loadZipHistory } from "./data";
import { MEMBERSHIP_TIERS, tierName } from "../membership";

export function EditUserModal({ user, onClose, onSaved, setToast, readOnly }) {
  const [name, setName] = useState(user.name || "");
  const [businessName, setBusinessName] = useState(user.business_name || "");
  const [zip, setZip] = useState(user.zip || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [verified, setVerified] = useState(!!user.verified);
  const [licenseActive, setLicenseActive] = useState(!!user.license_active);
  const [insuranceActive, setInsuranceActive] = useState(!!user.insurance_active);
  const [membershipTier, setMembershipTier] = useState(user.membership_tier || "free");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [zipHistory, setZipHistory] = useState(null);
  const [loadingZipHistory, setLoadingZipHistory] = useState(false);

  async function toggleZipHistory() {
    if (zipHistory !== null) { setZipHistory(null); return; }
    setLoadingZipHistory(true);
    try {
      setZipHistory(await loadZipHistory(user.id));
    } catch (e) {
      setToast?.(e.message || "Could not load ZIP history.");
    }
    setLoadingZipHistory(false);
  }

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
        fields.license_active = licenseActive;
        fields.insurance_active = insuranceActive;
        fields.membership_tier = membershipTier;
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
        <div style={{ fontFamily: sans, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>Edit user</div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>{user.email} · {user.role}</div>

        {user.role === "hauler" && (
          <Field label="Business name" value={businessName} onChange={setBusinessName} required />
        )}
        <Field label={user.role === "hauler" ? "Contact name" : "Full name"} value={name} onChange={setName} required />
        <Field label="ZIP code" value={zip} onChange={setZip} />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="(optional)" />

        {user.role === "hauler" && (
          <div style={{ marginBottom: 10 }}>
            <button onClick={toggleZipHistory} style={{
              background: "none", border: "none", color: C.teal, fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: 0,
            }}>
              {zipHistory !== null ? "Hide" : loadingZipHistory ? "Loading…" : "View"} ZIP change history
            </button>
            {zipHistory !== null && (
              <div style={{ marginTop: 6, display: "grid", gap: 4 }}>
                {zipHistory.length === 0 && <div style={{ fontSize: 11.5, color: C.gray }}>No ZIP changes on record.</div>}
                {zipHistory.map(h => (
                  <div key={h.id} style={{ fontSize: 11.5, color: C.gray }}>
                    {h.old_zip || "—"} → {h.new_zip} · {new Date(h.changed_at).toLocaleString()}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {user.role === "hauler" && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />
              Verified hauler
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={licenseActive} onChange={e => setLicenseActive(e.target.checked)} />
              Verified business license
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={insuranceActive} onChange={e => setInsuranceActive(e.target.checked)} />
              Verified insurance
            </label>
            <div style={{ fontSize: 11, color: C.gray, marginTop: -8, marginBottom: 14 }}>
              Checking these directly unlocks bidding — it bypasses the document upload/review flow in the Hauler docs tab.
            </div>

            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Membership tier</label>
            <select value={membershipTier} onChange={e => setMembershipTier(e.target.value)} style={{
              width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
              padding: "10px 13px", fontSize: 14, fontFamily: "inherit", color: C.ink, background: C.paper, marginBottom: 14,
            }}>
              {Object.keys(MEMBERSHIP_TIERS).map(t => <option key={t} value={t}>{tierName(t)}</option>)}
            </select>
          </>
        )}

        {error && <ErrorMsg>{error}</ErrorMsg>}

        {readOnly && (
          <div style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>👁️ View-only admin — changes can't be saved.</div>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <Btn variant="ghost" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Btn>
          {!readOnly && <Btn onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Btn>}
        </div>
      </div>
    </div>
  );
}
