import { useEffect, useState, useCallback, useRef } from "react";
import { C } from "./theme";
import { supabase } from "./lib/supabaseClient";
import { mapProfileToSession } from "./lib/session";
import { AuthLanding } from "./auth/AuthLanding";
import { AuthForm } from "./auth/AuthForm";
import { AdminInviteAccept } from "./auth/AdminInviteAccept";
import { TopBar } from "./ui/TopBar";
import { Toast } from "./ui/Toast";
import { CustomerDashboard } from "./dashboard/CustomerDashboard";
import { HaulerDashboard } from "./dashboard/HaulerDashboard";
import { AdminDashboard } from "./admin/AdminDashboard";

export default function App() {
  const [stage, setStage] = useState("loading"); // loading | landing | auth | app
  const [authRole, setAuthRole] = useState(null);
  const [session, setSession] = useState(null);
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

  const restoreSession = useCallback(async () => {
    if (adminInviteToken) {
      setStage("admin_invite");
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
    const mapped = mapProfileToSession(profile);
    setSession(mapped);
    setPage(mapped.role === "admin" ? "admin" : "dashboard");
    setStage("app");
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
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  function pickRole(role) {
    setAuthRole(role);
    setStage("auth");
  }
  function handleAuthed(user) {
    setSession(user);
    setPage(user.role === "admin" ? "admin" : "dashboard");
    setStage("app");
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
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@700;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
        body { background: ${C.sand}; }
        textarea:focus, input:focus { border-color: ${C.teal} !important; }
      `}</style>

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      {stage === "loading" && <div style={{ minHeight: "100vh", background: C.sandWarm }} />}
      {stage === "landing" && <AuthLanding onPick={pickRole} />}
      {stage === "auth" && <AuthForm role={authRole} onBack={() => setStage("landing")} onAuthed={handleAuthed} setToast={setToast} />}
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
