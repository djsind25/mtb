import { useEffect, useState, useCallback, useRef } from "react";
import { C } from "./theme";
import { supabase } from "./lib/supabaseClient";
import { mapProfileToSession } from "./lib/session";
import { AuthLanding } from "./auth/AuthLanding";
import { AuthForm } from "./auth/AuthForm";
import { TopBar } from "./ui/TopBar";
import { Toast } from "./ui/Toast";
import { JobsPage } from "./jobs/JobsPage";
import { ChatsListPage } from "./chat/ChatsListPage";
import { ChatThread } from "./chat/ChatThread";
import { AdminDashboard } from "./admin/AdminDashboard";

export default function App() {
  const [stage, setStage] = useState("loading"); // loading | landing | auth | app
  const [authRole, setAuthRole] = useState(null);
  const [session, setSession] = useState(null);
  const [page, setPage] = useState("jobs");
  const [activeChatId, setActiveChatId] = useState(null);
  const [toast, setToast] = useState(null);

  const restoreSession = useCallback(async () => {
    const { data: { session: authSession } } = await supabase.auth.getSession();
    if (!authSession) { setStage("landing"); return; }
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
    setPage(mapped.role === "admin" ? "admin" : "jobs");
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
    setPage(user.role === "admin" ? "admin" : "jobs");
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

      {stage === "app" && session && (
        <div style={{ minHeight: "100vh", background: C.sand }}>
          <TopBar session={session} onLogout={logout} onNav={(p) => { setPage(p); setActiveChatId(null); }} page={page} />
          {session.role === "admin" && page === "admin" && <AdminDashboard setToast={setToast} />}
          {session.role !== "admin" && page === "jobs" && (
            <JobsPage session={session} setToast={setToast} onOpenChat={(id) => { setActiveChatId(id); setPage("chats"); }} />
          )}
          {session.role !== "admin" && page === "chats" && !activeChatId && (
            <ChatsListPage session={session} onOpenChat={setActiveChatId} />
          )}
          {session.role !== "admin" && page === "chats" && activeChatId && (
            <ChatThread chatId={activeChatId} session={session} onClose={() => setActiveChatId(null)} setToast={setToast} />
          )}
        </div>
      )}
    </>
  );
}
