import { useEffect, useState } from "react";
import { C, RADIUS, SHADOW_SM } from "../theme";
import { Btn, CenteredNote, Badge } from "../ui/Primitives";
import { loadSecurityPolicyConfig, setAllowedMfaMethods } from "./data";

const METHODS = [
  { id: "passkey", label: "Passkey", helper: "Face ID / fingerprint — strongest, and the easiest for haulers with no app to install." },
  { id: "totp", label: "Authenticator app", helper: "TOTP via Google Authenticator, Authy, etc. — the original method." },
  { id: "email", label: "Email code", helper: "Fastest to set up, but weakest — it can never satisfy step-up re-auth on sensitive actions (only real login-MFA methods can), only the hauler bid-gate." },
];

export function SecurityPolicyTab({ session, readOnly, setToast }) {
  const [config, setConfig] = useState(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      setConfig(await loadSecurityPolicyConfig());
    } catch (e) {
      setToast?.(e.message || "Could not load security settings.");
    }
  }

  useEffect(() => { load(); }, []);

  const canEdit = !readOnly && session.superAdmin;

  async function toggleMethod(id) {
    const current = config.allowed_mfa_methods;
    const next = current.includes(id) ? current.filter(m => m !== id) : [...current, id];
    if (next.length === 0) { setToast("At least one method must stay allowed."); return; }
    setSaving(true);
    try {
      await setAllowedMfaMethods(next);
      await load();
      setToast("Allowed two-factor methods updated.");
    } catch (e) {
      setToast(e.message || "Could not update allowed methods.");
    }
    setSaving(false);
  }

  if (config === null) return <CenteredNote>Loading…</CenteredNote>;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 16, lineHeight: 1.6 }}>
        Controls which two-factor methods haulers and customers can choose from when setting up 2FA.
        Admin login-MFA always requires passkey or authenticator — email code can never satisfy it,
        so it's never offered there regardless of this setting. No SMS option exists here by design
        (SIM-swap risk and messaging-compliance overhead).
      </p>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "14px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep }}>Allowed 2FA methods</div>
          <Badge color={canEdit ? C.teal : C.gray} bg={canEdit ? C.tealLight : C.grayLight}>
            {canEdit ? "✓ Can edit" : "View only"}
          </Badge>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {METHODS.map(m => {
            const on = config.allowed_mfa_methods.includes(m.id);
            return (
              <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, borderBottom: `1px solid ${C.line}`, paddingBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>{m.label}</div>
                  <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>{m.helper}</div>
                </div>
                {canEdit ? (
                  <Btn size="sm" full={false} variant={on ? "ghost" : "primary"} disabled={saving} onClick={() => toggleMethod(m.id)}>
                    {on ? "Turn off" : "Turn on"}
                  </Btn>
                ) : (
                  <Badge color={on ? C.teal : C.gray} bg={on ? C.tealLight : C.grayLight}>{on ? "On" : "Off"}</Badge>
                )}
              </div>
            );
          })}
        </div>
        {!canEdit && !readOnly && (
          <div style={{ fontSize: 11, color: C.gray, marginTop: 10 }}>Only the super admin can change these.</div>
        )}
      </div>
    </div>
  );
}
