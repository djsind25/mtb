import { useEffect, useState, useCallback, useRef } from "react";
import { C } from "./theme";
import { supabase } from "./lib/supabaseClient";
import { mapProfileToSession } from "./lib/session";
import { AuthLanding } from "./auth/AuthLanding";
import { AuthForm } from "./auth/AuthForm";
import { AdminInviteAccept } from "./auth/AdminInviteAccept";
import { AuthRecovery } from "./auth/AuthRecovery";
import { CompleteOAuthProfile } from "./auth/CompleteOAuthProfile";
import { OAUTH_ROLE_KEY } from "./auth/socialAuth";
import { AuthShell } from "./auth/AuthShell";
import { MfaEnrollment } from "./auth/MfaEnrollment";
import { MfaChallenge } from "./auth/MfaChallenge";
import { listVerifiedTotpFactors, getAAL } from "./lib/mfa";
import { LegalReaccept } from "./auth/LegalReaccept";
import { needsLegalReaccept } from "./lib/legal";
import { TopBar } from "./ui/TopBar";
import { Toast } from "./ui/Toast";
import { CustomerDashboard } from "./dashboard/CustomerDashboard";
import { HaulerDashboard } from "./dashboard/HaulerDashboard";
import { AdminDashboard } from "./admin/AdminDashboard";

export default function App() {
  const [stage, setStage] = useState("loading"); // loading | landing | auth | recovery | admin_invite | oauth_profile | legal_reaccept | mfa_enroll | mfa_challenge | app
  const [authRole, setAuthRole] = useState(null);
  const [session, setSession] = useState(null);
  const [oauthProfile, setOauthProfile] = useState(null);
  const [oauthRoleHint, setOauthRoleHint] = useState(null);
  const [pendingSession, setPendingSession] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [activeChatId, setActiveChatId] = useState(null);
  const [toast, setToast] = useState(null);

  // Lets the marketing site deep-link straight into signup/login for a specific role, e.g.
  // linking its hauler CTAs at `?role=hauler` instead of dropping everyone on the role picker.
  const roleParam = new URLSearchParams(window.location.search).get("role");
  // An emailed admin-invite link (`?admin_invite=<token>`) takes priority over any existing
  // session — someone might click it from an inbox on a device where they're already logged in
  // as something else entirely.
  const adminInviteToken = new URLSearchParams(window.location.search).get("admin_invite");
  // A clicked passcode-reset link lands here with `#access_token=...&type=recovery` — that hash
  // establishes a real, valid session, so getSession() below would otherwise just log the user
  // straight in as if nothing special happened (a race the PASSWORD_RECOVERY listener alone
  // doesn't reliably win). Checking the hash upfront routes to the reset screen first regardless.
  const isRecoveryLink = window.location.hash.includes("type=recovery");

  const restoreSession = useCallback(async () => {
    if (adminInviteToken) {
      setStage("admin_invite");
      return;
    }
    if (isRecoveryLink) {
      setStage("recovery");
      return;
    }
    const { data: { session: authSession } } = await supabase.auth.getSession();
    if (!authSession) {
      if (roleParam === "customer" || roleParam === "hauler") {
        setAuthRole(roleParam);
        setStage("auth");
      } else {
        setStage("landing");
      }
      return;
    }
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", authSession.user.id).single();
    if (!profile) { setStage("landing"); return; }
    if (!profile.active) {
      await supabase.auth.signOut();
      setToast("This account has been deactivated. Contact support if you believe this is a mistake.");
      setStage("landing");
      return;
    }
    // Only ever set right before an OAuth redirect (see socialAuth.js) — its presence here means
    // this restore is happening right after that redirect back, not an ordinary page load.
    const oauthRoleHint = sessionStorage.getItem(OAUTH_ROLE_KEY);
    sessionStorage.removeItem(OAUTH_ROLE_KEY);
    // zip === '' is the auto-create trigger's hardcoded default for any OAuth signup — password
    // signups always supply a real zip, so this only ever fires for a fresh, never-onboarded
    // OAuth account. Admin accounts (created via AdminInviteAccept, which never collects a ZIP)
    // also have zip === '' — excluded here so an admin isn't misrouted into this customer/hauler
    // role-picker flow.
    if (profile.zip === "" && profile.role !== "admin") {
      if (oauthRoleHint) window.history.replaceState({}, "", window.location.pathname);
      setOauthProfile(profile);
      setOauthRoleHint(oauthRoleHint === "customer" || oauthRoleHint === "hauler" ? oauthRoleHint : null);
      setStage("oauth_profile");
      return;
    }
    if (oauthRoleHint && oauthRoleHint !== profile.role) {
      window.history.replaceState({}, "", window.location.pathname);
      await supabase.auth.signOut();
      const fix = profile.role === "customer" ? `Pick "I'm a customer" instead.`
        : profile.role === "hauler" ? `Pick "I'm a hauler" instead.`
        : `Use the Admin login link instead.`;
      setToast(`This account is registered as a ${profile.role}. ${fix}`);
      setStage("landing");
      return;
    }
    if (oauthRoleHint) window.history.replaceState({}, "", window.location.pathname);
    await finishLogin(mapProfileToSession(profile));
  }, []);

  useEffect(() => { restoreSession(); }, [restoreSession]);

  // AuthForm signs itself out mid-validation (wrong role, deactivated account) and shows its
  // own error on the auth screen — it doesn't want to be yanked back to landing when that
  // happens. This listener should only react to a session dying while actively in the app
  // (e.g. an expired/revoked token), so it checks a ref rather than "stage" directly to avoid
  // acting on a stale closure value from when the effect first ran.
  const stageRef = useRef(stage);
  useEffect(() => { stageRef.current = stage; }, [stage]);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT" && stageRef.current === "app") {
        setSession(null);
        setActiveChatId(null);
        setStage("landing");
      }
      // Fires once supabase-js has exchanged the token from a clicked passcode-reset email link —
      // takes over regardless of what screen was showing, same as the admin-invite link above.
      if (event === "PASSWORD_RECOVERY") {
        setStage("recovery");
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  function pickRole(role) {
    setAuthRole(role);
    setStage("auth");
  }
  // Single funnel every login path (password, Google, admin-invite-accept, OAuth-completion) goes
  // through before actually landing in the app. Admin accounts require MFA — no verified
  // authenticator yet routes to mandatory enrollment; a verified one whose session isn't already
  // aal2 (a fresh browser session, or one that's never done the login-time challenge) routes to
  // the code-entry screen. Both re-call finishLogin on success rather than duplicating the "land
  // in the app" tail below.
  async function finishLogin(mapped) {
    // Admins don't go through the customer/hauler signup flow this gates, so they're excluded —
    // scoped the same way the script's signup-acceptance requirement was ("customers AND haulers").
    if (mapped.role !== "admin") {
      try {
        if (await needsLegalReaccept(supabase)) {
          setPendingSession(mapped);
          setStage("legal_reaccept");
          return;
        }
      } catch (e) {
        setToast(e.message || "Could not verify Terms/Privacy acceptance status.");
        await supabase.auth.signOut();
        setStage("landing");
        return;
      }
    }
    if (mapped.role === "admin") {
      try {
        const factors = await listVerifiedTotpFactors(supabase);
        if (factors.length === 0) {
          setPendingSession(mapped);
          setStage("mfa_enroll");
          return;
        }
        const aal = await getAAL(supabase);
        if (aal.currentLevel !== "aal2") {
          setPendingSession(mapped);
          setStage("mfa_challenge");
          return;
        }
      } catch (e) {
        setToast(e.message || "Could not verify two-factor status.");
        await supabase.auth.signOut();
        setStage("landing");
        return;
      }
    }
    setSession(mapped);
    setPage(mapped.role === "admin" ? "admin" : "dashboard");
    setStage("app");
  }
  function handleAuthed(user) {
    finishLogin(user);
  }
  async function logout() {
    await supabase.auth.signOut();
    setSession(null);
    setActiveChatId(null);
    setStage("landing");
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');
        body { background: ${C.sand}; }
        textarea:focus, input:focus { border-color: ${C.teal} !important; }
      `}</style>

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      {stage === "loading" && <div style={{ minHeight: "100vh", background: C.sandWarm }} />}
      {stage === "landing" && <AuthLanding onPick={pickRole} />}
      {stage === "auth" && <AuthForm role={authRole} onBack={() => setStage("landing")} onAuthed={handleAuthed} setToast={setToast} />}
      {stage === "recovery" && (
        <AuthRecovery
          onAuthed={handleAuthed}
          onBack={async () => { await supabase.auth.signOut(); setStage("landing"); }}
        />
      )}
      {stage === "oauth_profile" && oauthProfile && (
        <CompleteOAuthProfile
          supabase={supabase}
          profile={oauthProfile}
          roleHint={oauthRoleHint}
          onDone={handleAuthed}
          onBack={async () => { await supabase.auth.signOut(); setOauthProfile(null); setStage("landing"); }}
        />
      )}

      {stage === "legal_reaccept" && pendingSession && (
        <LegalReaccept
          supabase={supabase}
          onDone={() => finishLogin(pendingSession)}
          onBack={async () => { await supabase.auth.signOut(); setPendingSession(null); setStage("landing"); }}
        />
      )}

      {stage === "mfa_enroll" && pendingSession && (
        <AuthShell
          title="Set up two-factor authentication"
          subtitle="Required for admin accounts"
          onBack={async () => { await supabase.auth.signOut(); setPendingSession(null); setStage("landing"); }}
        >
          <MfaEnrollment
            supabase={supabase}
            mandatory
            description="Admin accounts require two-factor authentication."
            onComplete={() => finishLogin(pendingSession)}
          />
        </AuthShell>
      )}

      {stage === "mfa_challenge" && pendingSession && (
        <AuthShell
          title="Two-factor verification"
          subtitle="Enter your authenticator code to continue"
          onBack={async () => { await supabase.auth.signOut(); setPendingSession(null); setStage("landing"); }}
        >
          <MfaChallenge
            supabase={supabase}
            onVerified={() => finishLogin(pendingSession)}
            onRecoveryCodeAccepted={() => setStage("mfa_enroll")}
          />
        </AuthShell>
      )}

      {stage === "admin_invite" && (
        <AdminInviteAccept
          token={adminInviteToken}
          onAuthed={(user) => {
            const url = new URL(window.location.href);
            url.searchParams.delete("admin_invite");
            window.history.replaceState({}, "", url);
            handleAuthed(user);
          }}
          onBack={() => {
            const url = new URL(window.location.href);
            url.searchParams.delete("admin_invite");
            window.history.replaceState({}, "", url);
            setStage("landing");
          }}
        />
      )}

      {stage === "app" && session && (
        <div style={{ minHeight: "100vh", background: C.sand }}>
          <TopBar session={session} onLogout={logout} onNav={setPage} page={page} setToast={setToast} />
          {session.role === "admin" && page === "admin" && <AdminDashboard session={session} setToast={setToast} />}
          {session.role === "customer" && page === "dashboard" && (
            <CustomerDashboard session={session} setToast={setToast} initialChatId={activeChatId} onConsumedInitialChat={() => setActiveChatId(null)} />
          )}
          {session.role === "hauler" && page === "dashboard" && (
            <HaulerDashboard session={session} setToast={setToast} initialChatId={activeChatId} onConsumedInitialChat={() => setActiveChatId(null)} />
          )}
        </div>
      )}
    </>
  );
}
