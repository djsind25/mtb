import { useEffect, useState } from "react";
import { C, sans } from "../theme";
import { Btn, Field, Badge, CenteredNote } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import {
  loadCustomerPayments, updateOwnProfile, updateNotificationPrefs,
  changeEmail, changePassword, deactivateOwnAccount, resendVerificationEmail, loadHaulerDocuments,
  requestProfileChange, loadMyProfileChangeRequests,
  loadAccountDeletionBlockers, requestOwnAccountDeletion, cancelOwnPendingDeletion,
} from "./data";
import { HaulerDocuments } from "./HaulerDocuments";
import { passcodeError, PASSCODE_HINT } from "../lib/passcode";
import { SmsAgreement } from "../auth/SmsAgreement";
import { isPushSupported, pushPermission, getCurrentPushSubscription, subscribeToPush, unsubscribeFromPush } from "../lib/push";
import { entitlementsFor, tierName } from "../membership";
import { LockedField } from "./LockedField";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { MfaEnrollment } from "../auth/MfaEnrollment";
import { listVerifiedTotpFactors } from "../lib/mfa";
import { loadMyLegalAcceptances } from "../lib/legal";
import { TOS_URL, PRIVACY_URL, TOS_VERSION, PRIVACY_VERSION } from "../legal/legalContent";

const EVENT_LABELS = {
  bidReceived: "New bid on your job",
  bidAccepted: "Your bid was accepted",
  newMessage: "New chat message",
  jobCompleted: "Job marked complete",
  reminderOverdue: "Completion reminder",
  jobBooked: "Your job is booked",
  documentExpiring: "Verification document expiring soon",
  documentExpired: "Verification document expired",
  jobQuestionAsked: "New question on your job",
  questionAnswered: "Your question was answered",
  bidRevisionProposed: "Your hauler proposed a new price",
  bidRevisionResolved: "A price revision you proposed was resolved",
  scheduleProposed: "A service date was proposed for your job",
  scheduleConfirmed: "Your proposed service date was confirmed",
  coordinationNudge: "Reminder to lock in a service date",
  paymentAuthorized: "Your payment method was authorized",
};

// Only the specific text-message categories asked for per role — adminMessage (a support reply)
// still texts both roles once they've opted into SMS overall, it just doesn't get its own toggle
// here to keep this list to what was actually requested.
const SMS_EVENT_LABELS = {
  hauler: {
    newJobNearby: "New jobs near you (hourly summary, not one text per job)",
    bidAccepted: "You won a job",
    newMessage: "New message from a customer",
    questionAnswered: "Your question was answered",
    bidRevisionResolved: "A price revision you proposed was resolved",
    scheduleProposed: "A service date was proposed",
    scheduleConfirmed: "A service date you proposed was confirmed",
    coordinationNudge: "Reminder to lock in a service date",
  },
  customer: {
    jobBooked: "Your job is booked",
    newMessage: "New message from a hauler",
    adminMessage: "New message from support",
    jobQuestionAsked: "New question on your job",
    bidRevisionProposed: "Your hauler proposed a new price",
    scheduleProposed: "A service date was proposed",
    scheduleConfirmed: "A service date you proposed was confirmed",
    coordinationNudge: "Reminder to lock in a service date",
    paymentAuthorized: "Your payment method was authorized",
  },
};

// Scoped to exactly what's wired server-side so far (see 20260821000000_web_push.sql) — new bid,
// bid accepted/booked, new message. Same shape as EVENT_LABELS, just a smaller set.
const PUSH_EVENT_LABELS = {
  bidReceived: "New bid on your job",
  bidAccepted: "Your bid was accepted",
  jobBooked: "Your job is booked",
  newMessage: "New chat message",
};

const sectionTitle = { fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 12 };
const checkboxRow = { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.ink, marginBottom: 8, cursor: "pointer" };

export function AccountTab({ session, setToast, onOpenEarnings }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [zip, setZip] = useState("");
  const [bio, setBio] = useState("");
  const [avatar, setAvatar] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const [pendingRequests, setPendingRequests] = useState({});
  const [requestingField, setRequestingField] = useState(null);

  const [prefs, setPrefs] = useState(null);
  const [smsConsent, setSmsConsent] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);

  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [togglingPush, setTogglingPush] = useState(false);

  const [history, setHistory] = useState([]);

  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const [deleteBlockers, setDeleteBlockers] = useState(null); // null = not checked yet this visit
  const [checkingBlockers, setCheckingBlockers] = useState(false);
  const [deletionReasonText, setDeletionReasonText] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cancellingDeletion, setCancellingDeletion] = useState(false);

  // Holds the function to run once StepUpChallenge confirms re-verification — one shared gate for
  // password change, email change, and account deactivation, rather than a separate flag per action.
  const [stepUpAction, setStepUpAction] = useState(null);

  const [resending, setResending] = useState(false);

  const [documents, setDocuments] = useState({});

  const [mfaEnrolled, setMfaEnrolled] = useState(null); // null = loading, else boolean
  const [showMfaEnroll, setShowMfaEnroll] = useState(false);

  const [legalAcceptances, setLegalAcceptances] = useState({});

  const loadMfaStatus = async () => {
    try {
      setMfaEnrolled((await listVerifiedTotpFactors(supabase)).length > 0);
    } catch {
      setMfaEnrolled(false);
    }
  };

  const loadDocuments = async () => {
    if (session.role !== "hauler") return;
    setDocuments(await loadHaulerDocuments(session.id));
  };

  const loadPendingRequests = async () => {
    if (session.role !== "hauler") return;
    setPendingRequests(await loadMyProfileChangeRequests(session.id));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Haulers' own earnings history lives entirely in the Earnings History tab (TotalEarnedTab) —
      // this section now just links there instead of duplicating the data fetch.
      const [{ data: p }, hist, legal] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", session.id).single(),
        session.role === "customer" ? loadCustomerPayments(session.id) : Promise.resolve([]),
        loadMyLegalAcceptances(supabase).catch(() => ({})),
      ]);
      if (session.role === "hauler") { await loadDocuments(); await loadPendingRequests(); }
      await loadMfaStatus();
      if (cancelled) return;
      setLegalAcceptances(legal);
      setProfile(p);
      setName(p.name || "");
      setEmail(p.email || "");
      setPhone(p.phone || "");
      setZip(p.zip || "");
      setBio(p.bio || "");
      setAvatar(p.avatar || "");
      setPrefs(p.notification_prefs);
      setSmsConsent(p.sms_consent || false);
      setHistory(hist);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [session.id, session.role]);

  useEffect(() => {
    let cancelled = false;
    if (isPushSupported()) {
      getCurrentPushSubscription().then(sub => { if (!cancelled) setPushSubscribed(!!sub); }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, []);

  async function togglePush() {
    setTogglingPush(true);
    try {
      if (pushSubscribed) {
        await unsubscribeFromPush();
        setPushSubscribed(false);
        setToast("Push notifications turned off on this device.");
      } else {
        await subscribeToPush(session.id);
        setPushSubscribed(true);
        setToast("Push notifications enabled on this device.");
      }
    } catch (e) {
      setToast(e.message || "Could not update push notifications.");
    }
    setTogglingPush(false);
  }

  // business_name moved out of this free-save path entirely — it's now change-request-only, see
  // the "Business & verification" section below.
  function saveProfile() {
    if (session.role === "hauler" && !phone.trim()) {
      setToast("A phone number is required for hauler accounts.");
      return;
    }
    const emailChanged = email.trim() !== profile.email;
    if (emailChanged) {
      // Changing the email is the sensitive part of this save — gate just that behind step-up
      // re-auth, but still save the harmless fields (name/phone/zip/bio/avatar) unconditionally.
      setStepUpAction(() => () => doSaveProfile(true));
      return;
    }
    doSaveProfile(false);
  }

  async function doSaveProfile(emailChanged) {
    setSavingProfile(true);
    try {
      const fields = {
        name: name.trim(), phone: phone.trim() || null, zip: zip.trim(),
        bio: bio.trim() || null, avatar: avatar.trim() || null,
      };
      await updateOwnProfile(session.id, fields);
      if (emailChanged) {
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

  async function submitFieldChange(field, value, reason) {
    setRequestingField(field);
    try {
      await requestProfileChange(field, value, reason);
      setToast("Change submitted for admin review.");
      await loadPendingRequests();
    } catch (e) {
      setToast(e.message || "Could not submit that change.");
    }
    setRequestingField(null);
  }

  async function savePrefs() {
    if (smsConsent && !phone.trim()) {
      setToast("Add a phone number above before enabling text messages.");
      return;
    }
    setSavingPrefs(true);
    try {
      await updateNotificationPrefs(session.id, prefs, smsConsent);
      setToast("Notification preferences saved.");
    } catch (e) {
      setToast(e.message || "Could not save preferences.");
    }
    setSavingPrefs(false);
  }

  function submitPasswordChange() {
    const pcError = passcodeError(newPassword);
    if (pcError) { setToast(pcError); return; }
    setStepUpAction(() => () => doPasswordChange());
  }

  async function doPasswordChange() {
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

  function confirmDeactivate() {
    setStepUpAction(() => (password) => doDeactivate(password));
  }

  async function doDeactivate(password) {
    setDeactivating(true);
    try {
      setToast("Account deactivated. Signing you out…");
      await deactivateOwnAccount(password);
      // supabase.auth.signOut() inside deactivateOwnAccount fires the app-level SIGNED_OUT
      // listener (App.jsx), which handles navigating back to the landing screen.
    } catch (e) {
      setToast(e.message || "Could not deactivate account.");
      setDeactivating(false);
    }
  }

  async function checkDeletionBlockers() {
    setCheckingBlockers(true);
    try {
      setDeleteBlockers(await loadAccountDeletionBlockers());
    } catch (e) {
      setToast(e.message || "Could not check your account status.");
    }
    setCheckingBlockers(false);
  }

  function confirmDelete() {
    setStepUpAction(() => (password) => doDelete(password));
  }

  async function doDelete(password) {
    setDeleting(true);
    try {
      setToast("Deletion requested. Signing you out…");
      await requestOwnAccountDeletion(deletionReasonText.trim() || null, password);
      // supabase.auth.signOut() inside requestOwnAccountDeletion fires the app-level SIGNED_OUT
      // listener (App.jsx), same as doDeactivate above.
    } catch (e) {
      setToast(e.message || "Could not request account deletion.");
      setDeleting(false);
    }
  }

  function confirmCancelDeletion() {
    setStepUpAction(() => (password) => doCancelDeletion(password));
  }

  async function doCancelDeletion(password) {
    setCancellingDeletion(true);
    try {
      await cancelOwnPendingDeletion(password);
      const { data: p } = await supabase.from("profiles").select("*").eq("id", session.id).single();
      setProfile(p);
      setToast("Deletion request cancelled.");
    } catch (e) {
      setToast(e.message || "Could not cancel the deletion request.");
    }
    setCancellingDeletion(false);
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
        <section style={{ border: `1.5px solid ${C.amber}66`, borderRadius: 12, padding: 16, background: C.amber + "16" }}>
          <div style={{ fontSize: 13, color: C.ink, fontWeight: 600, marginBottom: 10 }}>
            ⚠ Your email isn't verified yet{session.role === "customer" ? " — job posts won't be visible to haulers until it is" : ""}.
          </div>
          <Btn variant="ghost" full={false} onClick={resendVerification} disabled={resending}>
            {resending ? "Sending…" : "Resend verification email"}
          </Btn>
        </section>
      )}

      {session.role === "hauler" && (
        <HaulerDocuments haulerId={session.id} documents={documents} onChanged={loadDocuments} setToast={setToast} />
      )}

      {session.role === "hauler" && (
        <section>
          <div style={sectionTitle}>Membership</div>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, background: C.sand }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Badge color={C.teal} bg={C.tealLight}>{tierName(session.membershipTier)} plan</Badge>
            </div>
            <div style={{ display: "grid", gap: 6, fontSize: 12.5, color: C.ink, marginBottom: 10 }}>
              <div>📍 Browse radius: {entitlementsFor(session.membershipTier).maxRadiusMi} miles</div>
              <div>🧾 Platform commission: {(entitlementsFor(session.membershipTier).commissionRate * 100).toFixed(0)}%</div>
              <div>📮 Bids per month: {entitlementsFor(session.membershipTier).maxBidsPerMonth ?? "Unlimited"}</div>
              <div>⏱ Early access to new jobs: {entitlementsFor(session.membershipTier).earlyAccessMinutes > 0 ? `${entitlementsFor(session.membershipTier).earlyAccessMinutes} min` : "None"}</div>
              <div>⭐ Featured placement: {entitlementsFor(session.membershipTier).featuredPlacement ? "Yes" : "No"}</div>
            </div>
            {session.membershipTier === "free" && (
              <div style={{ fontSize: 12.5, color: C.gray, fontStyle: "italic" }}>
                You're on our free plan — no cost, no commitment.
              </div>
            )}
          </div>
        </section>
      )}

      <section>
        <div style={sectionTitle}>Profile</div>
        <Field label={session.role === "hauler" ? "Contact name" : "Full name"} value={name} onChange={setName} required />
        <Field label="Email" value={email} onChange={setEmail} type="email" hint="Changing this sends a confirmation link to the new address." />
        <Field label="Phone" value={phone} onChange={setPhone} type="tel" placeholder={session.role === "hauler" ? "(555) 867-5309" : "(optional)"} required={session.role === "hauler"} />
        <Field label="ZIP code" value={zip} onChange={setZip} hint={session.role === "hauler" ? "Changes are logged for admin visibility." : undefined} />
        <Field label="Bio" value={bio} onChange={setBio} placeholder="Tell customers a bit about you (optional)" />
        <Field label="Profile logo" value={avatar} onChange={setAvatar} placeholder="🚛 (an emoji for now)" hint="Shown next to your name across the app." />
        <Btn full={false} onClick={saveProfile} disabled={savingProfile}>{savingProfile ? "Saving…" : "Save profile"}</Btn>
      </section>

      {session.role === "hauler" && (
        <section>
          <div style={sectionTitle}>Business & verification</div>
          <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 12 }}>
            These affect how you're vetted, so an admin reviews changes before they take effect.
          </p>
          <LockedField label="Business name" value={profile.business_name}
            pendingRequest={pendingRequests.business_name} submitting={requestingField === "business_name"}
            onSubmit={(v, r) => submitFieldChange("business_name", v, r)} />
          <LockedField label="License number" value={profile.license_number}
            pendingRequest={pendingRequests.license_number} submitting={requestingField === "license_number"}
            onSubmit={(v, r) => submitFieldChange("license_number", v, r)} />
          <LockedField label="Insurance info" value={profile.insurance_info}
            pendingRequest={pendingRequests.insurance_info} submitting={requestingField === "insurance_info"}
            onSubmit={(v, r) => submitFieldChange("insurance_info", v, r)} />
          <LockedField label="Business registration number" value={profile.business_registration_number}
            pendingRequest={pendingRequests.business_registration_number} submitting={requestingField === "business_registration_number"}
            onSubmit={(v, r) => submitFieldChange("business_registration_number", v, r)} />

          <div style={{ height: 1, background: C.line, margin: "8px 0 16px" }} />

          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Verification & standing</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Badge color={profile.verified ? C.teal : C.gray} bg={profile.verified ? C.tealLight : C.grayLight}>
              {profile.verified ? "✓ Verified" : "Not verified"}
            </Badge>
            <Badge color={C.teal} bg={C.tealLight}>{tierName(session.membershipTier)} plan</Badge>
            {profile.rating_count > 0 ? (
              <Badge color={C.amber} bg={C.amberLight}>⭐ {Number(profile.rating).toFixed(1)} ({profile.rating_count})</Badge>
            ) : (
              <Badge color={C.gray} bg={C.grayLight}>No reviews yet</Badge>
            )}
          </div>
          <div style={{ fontSize: 11, color: C.gray, marginTop: 6 }}>
            These are set by MyTrashBid, not editable here.
          </div>
        </section>
      )}

      <section>
        <div style={sectionTitle}>Two-factor authentication</div>
        {mfaEnrolled === null ? null : mfaEnrolled ? (
          <Badge color={C.teal} bg={C.tealLight}>✓ Enabled</Badge>
        ) : showMfaEnroll ? (
          <MfaEnrollment
            supabase={supabase}
            mandatory={false}
            onComplete={() => { setShowMfaEnroll(false); loadMfaStatus(); setToast("Two-factor authentication enabled."); }}
            onCancel={() => setShowMfaEnroll(false)}
          />
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 12 }}>
              {session.role === "hauler"
                ? "Once your account is verified, you'll need this enabled before you can submit a bid — it protects your account and your earnings. Set it up now to get ahead of it."
                : "Add an extra layer of protection to your account with any authenticator app."}
            </p>
            <Btn full={false} onClick={() => setShowMfaEnroll(true)}>Set up two-factor authentication</Btn>
          </>
        )}
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

        <div style={{ height: 1, background: C.line, margin: "16px 0" }} />

        <SmsAgreement checked={smsConsent} onChange={setSmsConsent} />
        {smsConsent && !phone.trim() && (
          <div style={{ fontSize: 11.5, color: C.red, marginBottom: 8, marginLeft: 20 }}>
            Add a phone number above, then save, to actually receive texts.
          </div>
        )}
        {(SMS_EVENT_LABELS[session.role] ? Object.entries(SMS_EVENT_LABELS[session.role]) : []).map(([key, label]) => (
          <label key={key} style={{ ...checkboxRow, opacity: smsConsent ? 1 : 0.5, marginLeft: 20 }}>
            <input type="checkbox" checked={prefs.smsEvents?.[key] ?? true} disabled={!smsConsent}
              onChange={e => setPrefs({ ...prefs, smsEvents: { ...prefs.smsEvents, [key]: e.target.checked } })} />
            {label}
          </label>
        ))}

        <div style={{ height: 1, background: C.line, margin: "16px 0" }} />

        {!isPushSupported() ? (
          <div style={{ fontSize: 12, color: C.gray, marginBottom: 8 }}>
            Push notifications aren't available in this browser. On an iPhone, add MyTrashBid to your
            Home Screen first (Share → Add to Home Screen), then open it from there to enable push.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: pushSubscribed ? 8 : 0 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Push notifications</div>
                <div style={{ fontSize: 11.5, color: C.gray }}>
                  {pushPermission() === "denied"
                    ? "Blocked in your browser settings — re-enable notifications for this site to turn it back on."
                    : "Get a banner notification on this device for the events below."}
                </div>
              </div>
              <Btn variant={pushSubscribed ? "ghost" : "primary"} full={false} onClick={togglePush}
                disabled={togglingPush || pushPermission() === "denied"}>
                {togglingPush ? "…" : pushSubscribed ? "Turn off" : "Enable"}
              </Btn>
            </div>
            {pushSubscribed && Object.entries(PUSH_EVENT_LABELS).map(([key, label]) => (
              <label key={key} style={{ ...checkboxRow, marginLeft: 20, marginTop: 8 }}>
                <input type="checkbox" checked={prefs.pushEvents?.[key] ?? true}
                  onChange={e => setPrefs({ ...prefs, pushEvents: { ...prefs.pushEvents, [key]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </>
        )}

        <div style={{ marginTop: 8 }}>
          <Btn full={false} onClick={savePrefs} disabled={savingPrefs}>{savingPrefs ? "Saving…" : "Save preferences"}</Btn>
        </div>
      </section>

      <section>
        <div style={sectionTitle}>{session.role === "customer" ? "Payment history" : "Earnings History"}</div>
        {session.role === "customer" ? (
          <>
            {history.length === 0 && <CenteredNote>No payments yet.</CenteredNote>}
            <div style={{ display: "grid", gap: 8 }}>
              {history.map(h => (
                <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "10px 12px" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: C.pineDeep }}>{h.jobTitle}</div>
                    <div style={{ fontSize: 11.5, color: C.gray }}>{h.otherParty || "—"} · {new Date(h.createdAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontFamily: sans, fontVariantNumeric: "tabular-nums", fontWeight: 700, color: h.kind === "refund" ? C.red : C.pineDeep, marginBottom: 3 }}>
                      {h.kind === "refund" ? "−" : ""}${Number(h.amount).toFixed(2)}
                    </div>
                    <Badge color={h.kind === "refund" || h.status === "refunded" ? C.red : C.teal} bg={h.kind === "refund" || h.status === "refunded" ? C.redLight : C.tealLight}>
                      {h.kind === "refund" ? "refund" : h.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <Btn variant="ghost" full={false} onClick={onOpenEarnings}>View earnings history →</Btn>
        )}
      </section>

      <section>
        <div style={sectionTitle}>Change passcode</div>
        <Field label="New passcode" value={newPassword} onChange={setNewPassword} type="password" placeholder="At least 8 characters" hint={PASSCODE_HINT} />
        <Btn full={false} onClick={submitPasswordChange} disabled={changingPassword}>{changingPassword ? "Updating…" : "Update passcode"}</Btn>
      </section>

      <section>
        <div style={sectionTitle}>Legal</div>
        <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 10, lineHeight: 1.6 }}>
          {legalAcceptances.tos
            ? <>Accepted Terms of Service v{legalAcceptances.tos.version} on {new Date(legalAcceptances.tos.accepted_at).toLocaleDateString()}</>
            : <>Terms of Service (v{TOS_VERSION}) not yet accepted.</>}
          <br />
          {legalAcceptances.privacy
            ? <>Accepted Privacy Policy v{legalAcceptances.privacy.version} on {new Date(legalAcceptances.privacy.accepted_at).toLocaleDateString()}</>
            : <>Privacy Policy (v{PRIVACY_VERSION}) not yet accepted.</>}
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <a href={TOS_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, color: C.teal, textDecoration: "underline" }}>Terms of Service</a>
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12.5, color: C.teal, textDecoration: "underline" }}>Privacy Policy</a>
        </div>
      </section>

      <section style={{ border: `1.5px solid ${C.red}55`, borderRadius: 12, padding: 16, background: C.redLight }}>
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

        <div style={{ height: 1, background: C.red + "33", margin: "16px 0" }} />

        {profile.status === "deletion_requested" ? (
          <>
            <p style={{ fontSize: 12.5, color: C.ink, marginBottom: 8 }}>
              Your account is scheduled to be permanently deleted on{" "}
              <strong>{profile.deletion_scheduled_for ? new Date(profile.deletion_scheduled_for).toLocaleDateString() : "—"}</strong>.
              {profile.deletion_reason && <> Reason given: "{profile.deletion_reason}"</>}
            </p>
            <Btn variant="danger" full={false} onClick={confirmCancelDeletion} disabled={cancellingDeletion}>
              {cancellingDeletion ? "Cancelling…" : "Cancel deletion, keep my account"}
            </Btn>
          </>
        ) : (
          <>
            <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 10 }}>
              Deleting is permanent — your job/payment/review history is preserved for records, but
              your account can no longer be used to log in, post, or bid.
            </p>
            {deleteBlockers === null ? (
              <Btn variant="danger" full={false} onClick={checkDeletionBlockers} disabled={checkingBlockers}>
                {checkingBlockers ? "Checking…" : "Delete my account"}
              </Btn>
            ) : deleteBlockers.length > 0 ? (
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.red, marginBottom: 6 }}>
                  This account can't be deleted yet:
                </div>
                <ul style={{ margin: "0 0 10px", paddingLeft: 18, fontSize: 12, color: C.ink }}>
                  {deleteBlockers.map((b, i) => <li key={i} style={{ marginBottom: 4 }}>{b.message}</li>)}
                </ul>
                <Btn variant="ghost" full={false} onClick={() => setDeleteBlockers(null)}>Check again later</Btn>
              </div>
            ) : !confirmingDelete ? (
              <div>
                <Field label="Why are you leaving? (optional)" value={deletionReasonText} onChange={setDeletionReasonText} placeholder="Optional reason" />
                <Btn variant="danger" full={false} onClick={() => setConfirmingDelete(true)}>Delete my account</Btn>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8 }}>
                <Btn variant="ghost" full={false} onClick={() => setConfirmingDelete(false)}>Cancel</Btn>
                <Btn variant="danger" full={false} onClick={confirmDelete} disabled={deleting}>{deleting ? "Deleting…" : "Yes, delete my account"}</Btn>
              </div>
            )}
          </>
        )}
      </section>

      {stepUpAction && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={(password) => { const run = stepUpAction; setStepUpAction(null); run(password); }}
          onCancel={() => setStepUpAction(null)}
        />
      )}
    </div>
  );
}
