import { useState } from "react";
import { C, sans, RADIUS, SHADOW_MD } from "../theme";
import { Btn, Field, ErrorMsg, Badge } from "../ui/Primitives";
import { updateUserProfile, loadZipHistory, adminSetHaulerVerificationFlag } from "./data";
import { MEMBERSHIP_TIERS, tierName } from "../membership";
import { supabase } from "../lib/supabaseClient";
import { StepUpChallenge } from "../auth/StepUpChallenge";

const VERIFICATION_FIELDS = [
  { key: "verified", label: "Verified hauler" },
  { key: "license_active", label: "Verified business license" },
  { key: "insurance_active", label: "Verified insurance" },
];

export function EditUserModal({ user, onClose, onSaved, setToast, readOnly }) {
  const [name, setName] = useState(user.name || "");
  const [businessName, setBusinessName] = useState(user.business_name || "");
  const [zip, setZip] = useState(user.zip || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [membershipTier, setMembershipTier] = useState(user.membership_tier || "free");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // verified/license_active/insurance_active are no longer part of the plain-save form — they're
  // RPC-only now (20260816000000_hauler_verification_override.sql), so this bypasses the document
  // upload/review flow (Hauler docs tab) only with a recorded reason, not silently.
  const [confirmingField, setConfirmingField] = useState(null); // null | 'verified' | 'license_active' | 'insurance_active'
  const [verificationReason, setVerificationReason] = useState("");
  const [verificationStepUp, setVerificationStepUp] = useState(false);
  const [savingVerification, setSavingVerification] = useState(false);

  async function doSetVerificationFlag() {
    setSavingVerification(true);
    try {
      const nextValue = !user[confirmingField];
      await adminSetHaulerVerificationFlag(user.id, confirmingField, nextValue, verificationReason.trim());
      setToast("Verification status updated.");
      setConfirmingField(null);
      setVerificationReason("");
      onSaved();
    } catch (e) {
      setToast(e.message || "Could not update verification status.");
    }
    setSavingVerification(false);
  }

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
      <div style={{ background: C.paper, borderRadius: RADIUS.lg, boxShadow: SHADOW_MD, padding: 24, width: "100%", maxWidth: 420, border: `1px solid ${C.line}` }}>
        <div style={{ fontFamily: sans, fontSize: 19, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>Edit user</div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 16 }}>{user.email} · {user.role}</div>

        {user.role === "hauler" && (
          <Field label="Business name" value={businessName} onChange={setBusinessName} required />
        )}
        <Field label={user.role === "hauler" ? "Contact name" : "Full name"} value={name} onChange={setName} required />
        <Field label="ZIP code" value={zip} onChange={setZip} />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="(optional)" />

        {user.role === "customer" && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 14 }}>
            <input type="checkbox" checked={!!user.email_verified_at} disabled />
            Email verified{user.email_verified_at && ` (${new Date(user.email_verified_at).toLocaleDateString()})`}
          </label>
        )}

        {user.role !== "admin" && (user.status && user.status !== "active") && (
          <div style={{ fontSize: 12, color: C.gray, marginBottom: 14, background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "8px 10px" }}>
            <div style={{ fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>Account status: {user.status}</div>
            {user.status === "suspended" && user.suspended_at && (
              <div>Suspended {new Date(user.suspended_at).toLocaleDateString()}{user.suspension_reason && ` — "${user.suspension_reason}"`}</div>
            )}
            {user.status === "deletion_requested" && (
              <div>
                Requested {user.deletion_requested_at ? new Date(user.deletion_requested_at).toLocaleDateString() : "—"},
                {" "}scheduled {user.deletion_scheduled_for ? new Date(user.deletion_scheduled_for).toLocaleDateString() : "—"}
                {user.deletion_reason && ` — "${user.deletion_reason}"`}
              </div>
            )}
            {user.status === "anonymized" && user.anonymized_at && <div>Anonymized {new Date(user.anonymized_at).toLocaleDateString()}</div>}
            {user.status === "deleted" && user.deleted_at && <div>Marked deleted {new Date(user.deleted_at).toLocaleDateString()}</div>}
          </div>
        )}

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
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 6 }}>Verification status</div>
            <div style={{ fontSize: 11, color: C.gray, marginBottom: 8 }}>
              Normally set by reviewing documents in the Hauler docs tab. Overriding here bypasses
              that review and requires a reason — it's logged.
            </div>
            <div style={{ display: "grid", gap: 8, marginBottom: 14 }}>
              {VERIFICATION_FIELDS.map(f => {
                const value = !!user[f.key];
                const isConfirming = confirmingField === f.key;
                return (
                  <div key={f.key} style={{ border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "8px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: 13, color: C.ink }}>{f.label}</div>
                      <Badge color={value ? C.teal : C.gray} bg={value ? C.tealLight : C.grayLight}>{value ? "✓ Yes" : "No"}</Badge>
                    </div>
                    {!readOnly && !isConfirming && (
                      <button onClick={() => { setConfirmingField(f.key); setVerificationReason(""); }} style={{
                        background: "none", border: "none", color: C.teal, fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: 0, marginTop: 6,
                      }}>
                        {value ? "Revoke" : "Approve"} manually…
                      </button>
                    )}
                    {isConfirming && (
                      <div style={{ marginTop: 8 }}>
                        <input value={verificationReason} onChange={e => setVerificationReason(e.target.value)}
                          placeholder="Reason (required)" style={{
                            width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6,
                            padding: "6px 8px", fontSize: 12.5, fontFamily: "inherit", marginBottom: 6,
                          }} />
                        <div style={{ display: "flex", gap: 8 }}>
                          <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingField(null)}>Cancel</Btn>
                          <Btn size="sm" full={false} variant={value ? "danger" : "teal"} disabled={savingVerification || !verificationReason.trim()}
                            onClick={() => setVerificationStepUp(true)}>
                            {value ? "Confirm revoke" : "Confirm approve"}
                          </Btn>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Membership tier</label>
            <select value={membershipTier} onChange={e => setMembershipTier(e.target.value)} style={{
              width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm,
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

      {verificationStepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => { setVerificationStepUp(false); doSetVerificationFlag(); }}
          onCancel={() => setVerificationStepUp(false)}
        />
      )}
    </div>
  );
}
