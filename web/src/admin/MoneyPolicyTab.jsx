import { useEffect, useState } from "react";
import { C, sans, RADIUS, SHADOW_SM } from "../theme";
import { Btn, CenteredNote, Badge } from "../ui/Primitives";
import { tierName } from "../membership";
import { loadPlatformFeeConfig, setGlobalPlatformFeeRate, setTierPlatformFeeRate, setAllowAdminFeeEdits, setMinBidAmount, setMaxJobAmount } from "./data";

const TIERS = ["free", "pro", "premium"];

function pctInput(rate) {
  return rate == null ? "" : String(Math.round(rate * 10000) / 100);
}
function pctToRate(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return Math.round((n / 100) * 10000) / 10000;
}

export function MoneyPolicyTab({ session, readOnly, setToast }) {
  const [config, setConfig] = useState(null);
  const [globalInput, setGlobalInput] = useState("");
  const [tierInputs, setTierInputs] = useState({ free: "", pro: "", premium: "" });
  const [minBidInput, setMinBidInput] = useState("");
  const [maxJobInput, setMaxJobInput] = useState("");
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savingTier, setSavingTier] = useState(null);
  const [togglingEdits, setTogglingEdits] = useState(false);
  const [savingMinBid, setSavingMinBid] = useState(false);
  const [savingMaxJob, setSavingMaxJob] = useState(false);

  function applyConfig(cfg) {
    setConfig(cfg);
    setGlobalInput(pctInput(cfg.global_rate));
    setTierInputs({ free: pctInput(cfg.free_tier_rate), pro: pctInput(cfg.pro_tier_rate), premium: pctInput(cfg.premium_tier_rate) });
    setMinBidInput(String(cfg.min_bid_amount));
    setMaxJobInput(String(cfg.max_job_amount));
  }

  async function load() {
    const cfg = await loadPlatformFeeConfig();
    applyConfig(cfg);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadPlatformFeeConfig();
        if (cancelled) return;
        applyConfig(cfg);
      } catch (e) {
        if (!cancelled) setToast?.(e.message || "Could not load money policy settings.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function saveGlobal() {
    const rate = pctToRate(globalInput);
    if (rate == null || rate < 0 || rate >= 1) { setToast("Enter a percentage between 0 and 100."); return; }
    setSavingGlobal(true);
    try {
      await setGlobalPlatformFeeRate(rate);
      await load();
      setToast("Global platform fee updated.");
    } catch (e) {
      setToast(e.message || "Could not update the global fee.");
    }
    setSavingGlobal(false);
  }

  async function saveTier(tier) {
    const raw = tierInputs[tier];
    const rate = raw.trim() === "" ? null : pctToRate(raw);
    if (raw.trim() !== "" && (rate == null || rate < 0 || rate >= 1)) {
      setToast("Enter a percentage between 0 and 100, or leave blank to fall back to the global rate.");
      return;
    }
    setSavingTier(tier);
    try {
      await setTierPlatformFeeRate(tier, rate);
      await load();
      setToast(`${tierName(tier)} platform fee updated.`);
    } catch (e) {
      setToast(e.message || "Could not update this tier's fee.");
    }
    setSavingTier(null);
  }

  async function toggleAdminEdits() {
    const next = !config.allow_admin_fee_edits;
    setTogglingEdits(true);
    try {
      await setAllowAdminFeeEdits(next);
      await load();
      setToast(next ? "Regular admins can now edit platform fees." : "Regular admins can no longer edit platform fees.");
    } catch (e) {
      setToast(e.message || "Could not change this setting.");
    }
    setTogglingEdits(false);
  }

  async function saveMinBid() {
    const amount = Number(minBidInput);
    if (!Number.isFinite(amount) || amount <= 0) { setToast("Enter a minimum bid amount greater than $0."); return; }
    setSavingMinBid(true);
    try {
      await setMinBidAmount(amount);
      await load();
      setToast("Minimum bid amount updated.");
    } catch (e) {
      setToast(e.message || "Could not update the minimum bid amount.");
    }
    setSavingMinBid(false);
  }

  async function saveMaxJob() {
    const amount = Number(maxJobInput);
    if (!Number.isFinite(amount) || amount <= 0) { setToast("Enter a maximum job amount greater than $0."); return; }
    setSavingMaxJob(true);
    try {
      await setMaxJobAmount(amount);
      await load();
      setToast("Maximum job amount updated.");
    } catch (e) {
      setToast(e.message || "Could not update the maximum job amount.");
    }
    setSavingMaxJob(false);
  }

  if (config === null) return <CenteredNote>Loading…</CenteredNote>;

  const canEditFees = !readOnly && (session.superAdmin || config.allow_admin_fee_edits);
  const canEditToggle = !readOnly && session.superAdmin;
  const canEditLimits = !readOnly && session.superAdmin;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 16, lineHeight: 1.6 }}>
        The platform fee is the cut MyTrashBid keeps from every booked job. Each membership tier can
        override the global default — a blank tier falls back to it. Changing a rate here only
        affects future jobs; every already-booked job keeps the rate it was accepted under.
      </p>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "14px 16px", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep }}>Your edit access</div>
          <Badge color={canEditFees ? C.teal : C.gray} bg={canEditFees ? C.tealLight : C.grayLight}>
            {canEditFees ? "✓ Can edit" : "View only"}
          </Badge>
        </div>
        <div style={{ fontSize: 11.5, color: C.gray }}>
          {readOnly
            ? "View-only admins can never edit money policy."
            : session.superAdmin
            ? "You're the super admin — you can always edit fees, limits, and the toggle below."
            : config.allow_admin_fee_edits
            ? "Regular admins can currently edit the platform fee (the super admin turned this on). Job/bid limits are always super-admin-only."
            : "Regular admins cannot edit the platform fee right now — only view it. Job/bid limits are always super-admin-only."}
        </div>
      </div>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "14px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Global default fee</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ position: "relative" }}>
            <input
              type="number" step="0.01" min="0" max="99.99" value={globalInput}
              onChange={e => setGlobalInput(e.target.value)}
              disabled={!canEditFees || savingGlobal}
              style={{ width: 90, boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 24px 8px 10px", fontSize: 14, fontFamily: sans, color: C.ink }}
            />
            <span style={{ position: "absolute", right: 8, top: 0, bottom: 0, display: "flex", alignItems: "center", color: C.gray, fontSize: 13, pointerEvents: "none" }}>%</span>
          </div>
          {canEditFees && (
            <Btn size="sm" full={false} onClick={saveGlobal} disabled={savingGlobal}>{savingGlobal ? "Saving…" : "Save"}</Btn>
          )}
        </div>
      </div>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "14px 16px", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>Per-tier overrides</div>
        <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 10 }}>Leave a tier blank to use the global default.</div>
        <div style={{ display: "grid", gap: 10 }}>
          {TIERS.map(tier => {
            const overriding = tierInputs[tier].trim() !== "";
            return (
              <div key={tier} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ fontSize: 13, color: C.ink, minWidth: 70 }}>{tierName(tier)}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge color={overriding ? C.teal : C.gray} bg={overriding ? C.tealLight : C.grayLight}>
                    {overriding ? "Override" : "Uses global"}
                  </Badge>
                  <div style={{ position: "relative" }}>
                    <input
                      type="number" step="0.01" min="0" max="99.99" placeholder="—" value={tierInputs[tier]}
                      onChange={e => setTierInputs(t => ({ ...t, [tier]: e.target.value }))}
                      disabled={!canEditFees || savingTier === tier}
                      style={{ width: 80, boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "7px 22px 7px 9px", fontSize: 13, fontFamily: sans, color: C.ink }}
                    />
                    <span style={{ position: "absolute", right: 7, top: 0, bottom: 0, display: "flex", alignItems: "center", color: C.gray, fontSize: 12, pointerEvents: "none" }}>%</span>
                  </div>
                  {canEditFees && (
                    <Btn size="sm" full={false} variant="ghost" onClick={() => saveTier(tier)} disabled={savingTier === tier}>
                      {savingTier === tier ? "Saving…" : "Save"}
                    </Btn>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{
        background: config.allow_admin_fee_edits ? C.tealLight : C.grayLight,
        border: `1px solid ${config.allow_admin_fee_edits ? C.teal + "44" : C.line}`, borderRadius: RADIUS.md, padding: "12px 14px", marginBottom: 14,
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>
          Let regular admins edit the platform fee: {config.allow_admin_fee_edits ? "On" : "Off"}
        </div>
        <div style={{ fontSize: 11.5, color: C.gray, marginTop: 3 }}>
          Super-admin-only setting. When off, regular admins can view every rate but can't change any of them.
        </div>
        {canEditToggle && (
          <div style={{ marginTop: 10 }}>
            <Btn size="sm" full={false} variant="ghost" disabled={togglingEdits} onClick={toggleAdminEdits}>
              {togglingEdits ? "Switching…" : config.allow_admin_fee_edits ? "Turn off" : "Turn on"}
            </Btn>
          </div>
        )}
        {!canEditToggle && !readOnly && (
          <div style={{ fontSize: 11, color: C.gray, marginTop: 8 }}>Only the super admin can change this.</div>
        )}
      </div>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "14px 16px" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>Job & bid limits</div>
        <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 12 }}>
          Always super-admin-only — these caps shape fraud/chargeback exposure directly, so there's no
          delegation toggle like the fee above. A bid below the minimum is rejected with a clear message;
          a bid above the maximum shows a "contact us" message instead of a dead end.
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.ink }}>Minimum bid amount</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 9, top: 0, bottom: 0, display: "flex", alignItems: "center", color: C.gray, fontSize: 13, pointerEvents: "none" }}>$</span>
              <input
                type="number" step="1" min="0" value={minBidInput}
                onChange={e => setMinBidInput(e.target.value)}
                disabled={!canEditLimits || savingMinBid}
                style={{ width: 90, boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 10px 8px 20px", fontSize: 14, fontFamily: sans, color: C.ink }}
              />
            </div>
            {canEditLimits && (
              <Btn size="sm" full={false} onClick={saveMinBid} disabled={savingMinBid}>{savingMinBid ? "Saving…" : "Save"}</Btn>
            )}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13, color: C.ink }}>Maximum job amount</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: 9, top: 0, bottom: 0, display: "flex", alignItems: "center", color: C.gray, fontSize: 13, pointerEvents: "none" }}>$</span>
              <input
                type="number" step="1" min="0" value={maxJobInput}
                onChange={e => setMaxJobInput(e.target.value)}
                disabled={!canEditLimits || savingMaxJob}
                style={{ width: 90, boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 10px 8px 20px", fontSize: 14, fontFamily: sans, color: C.ink }}
              />
            </div>
            {canEditLimits && (
              <Btn size="sm" full={false} onClick={saveMaxJob} disabled={savingMaxJob}>{savingMaxJob ? "Saving…" : "Save"}</Btn>
            )}
          </div>
        </div>

        {!canEditLimits && !readOnly && (
          <div style={{ fontSize: 11, color: C.gray, marginTop: 10 }}>Only the super admin can change these.</div>
        )}
      </div>
    </div>
  );
}
