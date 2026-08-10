import { useEffect, useState } from "react";
import { C, RADIUS, SHADOW_SM } from "../theme";
import { Btn } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import {
  getDeferredInstallPrompt, onInstallPromptAvailable, clearDeferredInstallPrompt,
  isStandaloneDisplay, isIOS, isAndroid,
} from "../lib/installPrompt";

const RETURN_VISIT_AFTER_MS = 24 * 60 * 60 * 1000; // account created more than a day ago

// A simple upward-arrow-out-of-a-box glyph standing in for iOS's Share icon, since there's no
// icon library in this app (see the emoji-vs-icon-library decision still pending elsewhere) —
// close enough for a one-off visual cue and avoids pulling in a dependency for a single icon.
function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.teal} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: "-4px", margin: "0 2px" }}>
      <path d="M12 3v12" /><path d="M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

// Lives in Account → (under Verification & standing for haulers). Stays hidden until the app is
// actually installable, the visitor is on a phone, and they've either done something meaningful
// (posted a job / placed a bid) or it's a return visit — never nags a brand-new same-day visitor.
export function InstallPrompt({ session }) {
  const [status, setStatus] = useState("checking"); // checking | hidden | android | ios
  const [deferredPrompt, setDeferredPrompt] = useState(() => getDeferredInstallPrompt());
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (isStandaloneDisplay() || !(isIOS() || isAndroid())) {
      setStatus("hidden");
      return;
    }
    let cancelled = false;
    (async () => {
      const [{ data: profile }, { count }] = await Promise.all([
        supabase.from("profiles").select("created_at, pwa_install_dismissed_at").eq("id", session.id).single(),
        session.role === "hauler"
          ? supabase.from("bids").select("id", { count: "exact", head: true }).eq("hauler_id", session.id)
          : supabase.from("jobs").select("id", { count: "exact", head: true }).eq("customer_id", session.id),
      ]);
      if (cancelled) return;
      if (profile?.pwa_install_dismissed_at) {
        setStatus("hidden");
        return;
      }
      const accountAgeMs = profile?.created_at ? Date.now() - new Date(profile.created_at).getTime() : 0;
      const earned = accountAgeMs > RETURN_VISIT_AFTER_MS || (count || 0) > 0;
      if (!earned) {
        setStatus("hidden");
        return;
      }
      setStatus(isIOS() ? "ios" : "android");
    })();
    return () => { cancelled = true; };
  }, [session.id, session.role]);

  useEffect(() => {
    return onInstallPromptAvailable(e => setDeferredPrompt(e));
  }, []);

  async function dismiss() {
    setStatus("hidden");
    try {
      await supabase.from("profiles").update({ pwa_install_dismissed_at: new Date().toISOString() }).eq("id", session.id);
    } catch {
      // Non-critical — worst case they see the banner again next visit.
    }
  }

  async function install() {
    if (!deferredPrompt) return;
    setInstalling(true);
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } finally {
      clearDeferredInstallPrompt();
      setDeferredPrompt(null);
      setInstalling(false);
      setStatus("hidden");
    }
  }

  if (status === "hidden" || status === "checking") return null;
  // Android but the native prompt hasn't fired (already dismissed once this browser session,
  // criteria not yet met, etc.) — nothing to trigger, so showing our button would be a dead end.
  if (status === "android" && !deferredPrompt) return null;

  return (
    <section style={{
      border: `1px solid ${C.teal}55`, borderRadius: RADIUS.md, padding: 16,
      background: C.tealLight, boxShadow: SHADOW_SM, marginBottom: 4,
    }}>
      {status === "android" ? (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>
            📲 Install MyTrashBid
          </div>
          <div style={{ fontSize: 12.5, color: C.ink, marginBottom: 12 }}>
            Add it to your home screen for one-tap access to jobs, bids, and messages.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn size="sm" full={false} onClick={install} disabled={installing}>
              {installing ? "Opening…" : "Install MyTrashBid"}
            </Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={dismiss}>Not now</Btn>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>
            📲 Add MyTrashBid App to Home Screen
          </div>
          <div style={{ fontSize: 12.5, color: C.ink, marginBottom: 12 }}>
            Tap <ShareGlyph /> <strong>Share</strong> in Safari, then <strong>"Add to Home Screen"</strong> — one tap gets you back in from your home screen.
          </div>
          <Btn size="sm" full={false} variant="ghost" onClick={dismiss}>Got it</Btn>
        </>
      )}
    </section>
  );
}
