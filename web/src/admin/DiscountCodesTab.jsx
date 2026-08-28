import { useEffect, useState } from "react";
import { C, RADIUS, SHADOW_SM } from "../theme";
import { Btn, Badge, CenteredNote, Field } from "../ui/Primitives";
import { StepUpChallenge } from "../auth/StepUpChallenge";
import { supabase } from "../lib/supabaseClient";
import {
  adminCreateDiscountCode, adminSetDiscountCodeActive, loadAdminDiscountCodes,
  loadAdminDiscountCodeRedemptions, loadAdminDiscountProgramStats,
} from "./data";

export function DiscountCodesTab({ readOnly, setToast }) {
  const [codes, setCodes] = useState(null);
  const [stats, setStats] = useState(null);
  const [viewingCodeId, setViewingCodeId] = useState(null);
  const [redemptions, setRedemptions] = useState(null);

  const [code, setCode] = useState("");
  const [discountValue, setDiscountValue] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [creating, setCreating] = useState(false);
  const [stepUp, setStepUp] = useState(null); // null | "create" | { toggleId, next }

  async function load() {
    const [c, s] = await Promise.all([loadAdminDiscountCodes(), loadAdminDiscountProgramStats()]);
    setCodes(c);
    setStats(s);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!viewingCodeId) { setRedemptions(null); return; }
    let cancelled = false;
    loadAdminDiscountCodeRedemptions(viewingCodeId).then(r => { if (!cancelled) setRedemptions(r); });
    return () => { cancelled = true; };
  }, [viewingCodeId]);

  async function doCreate() {
    setCreating(true);
    try {
      await adminCreateDiscountCode(
        code.trim(), Number(discountValue),
        expiresAt ? new Date(expiresAt).toISOString() : null,
        maxRedemptions ? Number(maxRedemptions) : null,
      );
      setToast(`Code "${code.trim().toUpperCase()}" created.`);
      setCode(""); setDiscountValue(""); setExpiresAt(""); setMaxRedemptions("");
      await load();
    } catch (e) {
      setToast(e.message || "Could not create that code.");
    }
    setCreating(false);
  }

  async function doToggleActive(codeId, next) {
    try {
      await adminSetDiscountCodeActive(codeId, next);
      setToast(next ? "Code reactivated." : "Code deactivated.");
      await load();
    } catch (e) {
      setToast(e.message || "Could not update that code.");
    }
  }

  const viewingCode = codes?.find(c => c.id === viewingCodeId);

  return (
    <div>
      {stats && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <Stat label="Codes created" value={stats.total_codes} />
          <Stat label="Total redemptions" value={stats.total_redemptions} />
          <Stat label="Fee revenue foregone" value={`$${Number(stats.total_saved).toFixed(2)}`} />
        </div>
      )}

      {!readOnly && (
        <div style={{ background: C.sand, borderRadius: RADIUS.md, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>Create a code</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginBottom: 8 }}>
            <Field label="Code" value={code} onChange={v => setCode(v.toUpperCase())} placeholder="SAVE3" />
            <Field label="Points off fee" value={discountValue} onChange={setDiscountValue} type="number" placeholder="3" hint="e.g. 3 turns a 10% fee into 7%" />
            <Field label="Expires (optional)" value={expiresAt} onChange={setExpiresAt} type="date" />
            <Field label="Max redemptions (optional)" value={maxRedemptions} onChange={setMaxRedemptions} type="number" placeholder="Unlimited" />
          </div>
          <Btn size="sm" full={false} disabled={creating || !code.trim() || !discountValue} onClick={() => setStepUp("create")}>
            {creating ? "Creating…" : "Create code"}
          </Btn>
        </div>
      )}

      {viewingCodeId ? (
        <div>
          <button onClick={() => setViewingCodeId(null)} style={{
            background: "none", border: "none", color: C.gray, fontSize: 12.5, cursor: "pointer",
            textDecoration: "underline", marginBottom: 12, display: "block", padding: 0,
          }}>← Back to codes</button>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>
            Redemptions — {viewingCode?.code}
          </div>
          {redemptions === null ? (
            <CenteredNote>Loading…</CenteredNote>
          ) : redemptions.length === 0 ? (
            <CenteredNote>No redemptions on this code yet.</CenteredNote>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {redemptions.map(r => (
                <div key={r.id} style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, boxShadow: SHADOW_SM, padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.pineDeep }}>{r.hauler_name || "Unknown"}</div>
                    <div style={{ fontSize: 11.5, color: C.gray }}>{r.job_title} · {new Date(r.created_at).toLocaleDateString()}</div>
                  </div>
                  <Badge color={C.teal} bg={C.tealLight}>Saved ${Number(r.amount_saved).toFixed(2)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div>
          {codes === null ? (
            <CenteredNote>Loading…</CenteredNote>
          ) : codes.length === 0 ? (
            <CenteredNote>No discount codes yet.</CenteredNote>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {codes.map(c => (
                <div key={c.id} style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, boxShadow: SHADOW_SM, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{c.code}</span>
                        {c.active ? <Badge color={C.teal} bg={C.tealLight}>active</Badge> : <Badge color={C.gray} bg={C.grayLight}>inactive</Badge>}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.gray }}>
                        {Number(c.discount_value)} points off fee
                        {c.expires_at && ` · expires ${new Date(c.expires_at).toLocaleDateString()}`}
                        {c.max_redemptions && ` · max ${c.max_redemptions} redemptions`}
                      </div>
                      <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
                        {c.redemption_count} redeemed{c.redemption_count > 0 && ` · $${Number(c.total_saved).toFixed(2)} given up`}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <Btn size="sm" full={false} variant="ghost" onClick={() => setViewingCodeId(c.id)}>
                        {c.redemption_count > 0 ? "View redemptions" : "Details"}
                      </Btn>
                      {!readOnly && (
                        <Btn size="sm" full={false} variant="ghost" onClick={() => setStepUp({ toggleId: c.id, next: !c.active })}>
                          {c.active ? "Deactivate" : "Reactivate"}
                        </Btn>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {stepUp && (
        <StepUpChallenge
          supabase={supabase}
          onVerified={() => {
            const action = stepUp;
            setStepUp(null);
            if (action === "create") doCreate();
            else doToggleActive(action.toggleId, action.next);
          }}
          onCancel={() => setStepUp(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "10px 14px", minWidth: 140 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.pineDeep, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 11, color: C.gray }}>{label}</div>
    </div>
  );
}
