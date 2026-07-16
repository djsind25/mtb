import { useEffect, useState } from "react";
import { C, mono } from "../theme";
import { Btn, Field, Badge, CenteredNote } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import {
  loadCustomerPayments, loadHaulerEarnings, updateOwnProfile, updateNotificationPrefs,
  changeEmail, changePassword, deactivateOwnAccount, resendVerificationEmail,
} from "./data";

const EVENT_LABELS = {
  bidReceived: "New bid on your job",
  bidAccepted: "Your bid was accepted",
  newMessage: "New chat message",
  jobCompleted: "Job marked complete",
  reminderOverdue: "Completion reminder",
};

const sectionTitle = { fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 12 };
const checkboxRow = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 8, cursor: "pointer" };

export function AccountTab({ session, setToast }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [zip, setZip] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const [prefs, setPrefs] = useState(null);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [history, setHistory] = useState([]);

  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const [resending, setResending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: p }, hist] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", session.id).single(),
        session.role === "customer" ? loadCustomerPayments(session.id) : loadHaulerEarnings(session.id),
      ]);
      if (cancelled) return;
      setProfile(p);
      setName(p.name || "");
      setBusinessName(p.business_name || "");
      setEmail(p.email || "");
      setPhone(p.phone || "");
      setZip(p.zip || "");
      setPrefs(p.notification_prefs);
      setHistory(hist);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.id, session.role]);

  async function saveProfile() {
    setSavingProfile(true);
    try {
      const fields = { name: name.trim(), phone: phone.trim() || null, zip: zip.trim() };
      if (session.role === "hauler") fields.business_name = businessName.trim();
      await updateOwnProfile(session.id, fields);
      if (email.trim() !== profile.email) {
        await changeEmail(email.trim());
        setToast("Profile saved. Check your inbox to confirm the new email address.");
      } else {
        setToast("Profile saved.");
      }
    } catch (e) {
      setToast(e.message || "Could not save profile.");
    }
    setSavingProfile(false);
  }

  async function savePrefs() {
    setSavingPrefs(true);
    try {
      await updateNotificationPrefs(session.id, prefs);
      setToast("Notification preferences saved.");
    } catch (e) {
      setToast(e.message || "Could not save preferences.");
    }
    setSavingPrefs(false);
  }

  async function submitPasswordChange() {
    if (newPassword.trim().length < 6) { setToast("Passcode must be at least 6 characters."); return; }
    setChangingPassword(true);
    try {
      await changePassword(newPassword.trim());
      setNewPassword("");
      setToast("Passcode updated.");
    } catch (e) {
      setToast(e.message || "Could not update passcode.");
    }
    setChangingPassword(false);
  }

  async function confirmDeactivate() {
    setDeactivating(true);
    try {
      setToast("Account deactivated. Signing you out…");
      await deactivateOwnAccount(session.id);
      // supabase.auth.signOut() inside deactivateOwnAccount fires the app-level SIGNED_OUT
      // listener (App.jsx), which handles navigating back to the landing screen.
    } catch (e) {
      setToast(e.message || "Could not deactivate account.");
      setDeactivating(false);
    }
  }

  async function resendVerification() {
    setResending(true);
    try {
      await resendVerificationEmail();
      setToast("Verification email sent — check your inbox.");
    } catch (e) {
      setToast(e.message || "Could not resend verification email.");
    }
    setResending(false);
  }

  if (loading || !prefs) return <CenteredNote>Loading account…</CenteredNote>;

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {!profile.email_verified_at && (
        <section style={{ border: `1.5px solid ${C.amber}66`, borderRadius: 18, padding: 16, background: C.amber + "16" }}>
          <div style={{ fontSize: 13, color: C.ink, fontWeight: 600, marginBottom: 10 }}>
            ⚠ Your email isn't verified yet{session.role === "customer" ? " — job posts won't be visible to haulers until it is" : ""}.
          </div>
          <Btn variant="ghost" full={false} onClick={resendVerification} disabled={resending}>
            {resending ? "Sending…" : "Resend verification email"}
          </Btn>
        </section>
      )}

      <section>
        <div style={sectionTitle}>Profile</div>
        {session.role === "hauler" && <Field label="Business name" value={businessName} onChange={setBusinessName} required />}
        <Field label={session.role === "hauler" ? "Contact name" : "Full name"} value={name} onChange={setName} required />
        <Field label="Email" value={email} onChange={setEmail} type="email" hint="Changing this sends a confirmation link to the new address." />
        <Field label="Phone" value={phone} onChange={setPhone} placeholder="(optional)" />
        <Field label="ZIP code" value={zip} onChange={setZip} />
        <Btn full={false} onClick={saveProfile} disabled={savingProfile}>{savingProfile ? "Saving…" : "Save profile"}</Btn>
      </section>

      <section>
        <div style={sectionTitle}>Notifications</div>
        <label style={checkboxRow}>
          <input type="checkbox" checked={prefs.email} onChange={e => setPrefs({ ...prefs, email: e.target.checked })} />
          Email notifications (master toggle)
        </label>
        {Object.entries(EVENT_LABELS).map(([key, label]) => (
          <label key={key} style={{ ...checkboxRow, opacity: prefs.email ? 1 : 0.5, marginLeft: 20 }}>
            <input type="checkbox" checked={prefs.events?.[key] ?? true} disabled={!prefs.email}
              onChange={e => setPrefs({ ...prefs, events: { ...prefs.events, [key]: e.target.checked } })} />
            {label}
          </label>
        ))}
        <div style={{ marginTop: 8 }}>
          <Btn full={false} onClick={savePrefs} disabled={savingPrefs}>{savingPrefs ? "Saving…" : "Save preferences"}</Btn>
        </div>
      </section>

      <section>
        <div style={sectionTitle}>{session.role === "customer" ? "Payment history" : "Earnings history"}</div>
        {history.length === 0 && <CenteredNote>{session.role === "customer" ? "No payments yet." : "No earnings yet."}</CenteredNote>}
        <div style={{ display: "grid", gap: 8 }}>
          {history.map(h => (
            <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 16, padding: "10px 12px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: C.pineDeep }}>{h.jobTitle}</div>
                <div style={{ fontSize: 11.5, color: C.gray }}>{h.otherParty || "—"} · {new Date(h.createdAt).toLocaleDateString()}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep, marginBottom: 3 }}>${Number(h.amount).toFixed(2)}</div>
                <Badge color={h.status === "refunded" ? C.red : C.teal} bg={h.status === "refunded" ? C.redLight : C.tealLight}>{h.status}</Badge>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div style={sectionTitle}>Change passcode</div>
        <Field label="New passcode" value={newPassword} onChange={setNewPassword} type="password" placeholder="At least 6 characters" />
        <Btn full={false} onClick={submitPasswordChange} disabled={changingPassword}>{changingPassword ? "Updating…" : "Update passcode"}</Btn>
      </section>

      <section style={{ border: `1.5px solid ${C.red}55`, borderRadius: 18, padding: 16, background: C.redLight }}>
        <div style={{ ...sectionTitle, color: C.red }}>Danger zone</div>
        <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 10 }}>
          Deactivating signs you out immediately and blocks future logins. Contact support if you need to reactivate.
        </p>
        {!confirmingDeactivate ? (
          <Btn variant="danger" full={false} onClick={() => setConfirmingDeactivate(true)}>Deactivate my account</Btn>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="ghost" full={false} onClick={() => setConfirmingDeactivate(false)}>Cancel</Btn>
            <Btn variant="danger" full={false} onClick={confirmDeactivate} disabled={deactivating}>{deactivating ? "Deactivating…" : "Yes, deactivate"}</Btn>
          </div>
        )}
      </section>
    </div>
  );
}
