import { useEffect, useState } from "react";
import { sans, C, RADIUS } from "../theme";
import { Btn } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import { createConnectAccount, createConnectAccountLink } from "./data";

// Stripe's account-link URLs are single-use and expire after a few minutes, so both the initial
// onboarding attempt and any later "refresh" land back on this same app with a plain query param
// (this app has no path-based router — see App.jsx's ?admin_invite=/?role= convention) rather
// than a dedicated route. There's no functional difference between the two from the platform's
// side, so one component + one Edge Function pair covers both.
const RETURN_PARAM = "connect_return";
const REFRESH_PARAM = "connect_refresh";
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 15; // ~30s — long enough for Stripe's account.updated webhook to land

function clearConnectParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete(RETURN_PARAM);
  url.searchParams.delete(REFRESH_PARAM);
  window.history.replaceState({}, "", url);
}

async function fetchConnectStatus(haulerId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("stripe_connect_charges_enabled, stripe_connect_payouts_enabled")
    .eq("id", haulerId)
    .single();
  if (error) throw error;
  return !!data.stripe_connect_charges_enabled && !!data.stripe_connect_payouts_enabled;
}

export function HaulerConnectOnboarding({ session, setToast }) {
  const params = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState(
    params.has(RETURN_PARAM) ? "polling" : params.has(REFRESH_PARAM) ? "refreshing" : "idle"
  );
  const [starting, setStarting] = useState(false);

  async function startOnboarding() {
    setStarting(true);
    try {
      await createConnectAccount();
      const { url } = await createConnectAccountLink();
      window.location.href = url;
    } catch (e) {
      setToast(e.message || "Could not start Stripe onboarding.");
      setStarting(false);
    }
  }

  // ?connect_refresh=1 — Stripe sent the hauler back here because their onboarding link expired
  // mid-flow. Nothing to show; just get them a fresh link immediately.
  useEffect(() => {
    if (mode !== "refreshing") return;
    (async () => {
      try {
        const { url } = await createConnectAccountLink();
        window.location.href = url;
      } catch (e) {
        clearConnectParams();
        setToast(e.message || "Could not resume Stripe onboarding. Please try again.");
        setMode("idle");
      }
    })();
  }, [mode, setToast]);

  // ?connect_return=1 — the hauler just finished (or abandoned) Stripe's hosted flow. Poll briefly
  // rather than trusting a single check: Stripe's account.updated webhook can take a few seconds
  // to land after the redirect, so a hauler who really did finish shouldn't see a false "not done
  // yet" the instant they land back here.
  useEffect(() => {
    if (mode !== "polling") return;
    let cancelled = false;
    let attempts = 0;

    async function poll() {
      attempts += 1;
      try {
        const onboarded = await fetchConnectStatus(session.id);
        if (cancelled) return;
        if (onboarded) {
          clearConnectParams();
          // session is a plain snapshot passed down from App.jsx with no live-update path from
          // this deep in the tree — a full reload re-runs restoreSession() and picks up the now-
          // current Connect flags, same as how every other cross-cutting profile change in this
          // app (role, verification, etc.) only reliably reflects after a fresh session load.
          window.location.reload();
          return;
        }
      } catch {
        // transient read failure — just let the next poll tick retry
      }
      if (attempts < POLL_MAX_ATTEMPTS) {
        setTimeout(poll, POLL_INTERVAL_MS);
      } else if (!cancelled) {
        setMode("timedOut");
      }
    }
    poll();
    return () => { cancelled = true; };
  }, [mode, session.id]);

  if (session.connectOnboarded) return null;

  return (
    <div style={{
      background: C.tealLight, border: `1.5px solid ${C.teal}`, borderRadius: RADIUS.md,
      padding: 18, marginBottom: 18,
    }}>
      <div style={{ fontFamily: sans, fontWeight: 700, fontSize: 15, color: C.pineDeep, marginBottom: 6 }}>
        💳 Set up payouts to start bidding
      </div>

      {(mode === "polling" || mode === "refreshing") && (
        <p style={{ fontSize: 13, color: C.ink, marginBottom: 0 }}>
          {mode === "refreshing" ? "Reopening Stripe…" : "Finishing setup — this takes just a moment…"}
        </p>
      )}

      {mode === "timedOut" && (
        <>
          <p style={{ fontSize: 13, color: C.ink, marginBottom: 12 }}>
            Still confirming with Stripe. If you completed onboarding, this can take a minute to sync — check again, or start over if something went wrong.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn size="sm" full={false} onClick={() => { setMode("polling"); }}>Check again</Btn>
            <Btn size="sm" full={false} variant="ghost" disabled={starting} onClick={startOnboarding}>
              {starting ? "Starting…" : "Start over"}
            </Btn>
          </div>
        </>
      )}

      {mode === "idle" && (
        <>
          <p style={{ fontSize: 13, color: C.ink, marginBottom: 12 }}>
            Connect a bank account through Stripe before you can bid — this is how you get paid once a customer approves your completed job. Takes a few minutes; Stripe handles your identity and bank details directly.
          </p>
          <Btn size="sm" full={false} disabled={starting} onClick={startOnboarding}>
            {starting ? "Starting…" : "Set up payouts with Stripe"}
          </Btn>
        </>
      )}
    </div>
  );
}
