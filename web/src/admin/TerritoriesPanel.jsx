import { useState } from "react";
import { C, RADIUS, SHADOW_SM } from "../theme";
import { Btn, Field, Badge, CenteredNote } from "../ui/Primitives";
import {
  loadTerritoryStates, loadTerritoryZips, adminCreateTerritory, adminRenameTerritory,
  adminSetTerritoryStates, adminAssignZipsToTerritory, adminDeleteTerritory,
} from "./data";

const SCOPE_LABEL = { all: "All (nationwide)", states: "States", zips: "ZIP list" };

function TerritoryRow({ territory, onChanged, setToast }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(territory.name);
  const [statesText, setStatesText] = useState("");
  const [zipsText, setZipsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function toggleExpand() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    setLoading(true);
    try {
      if (territory.scope_type === "states") {
        setStatesText((await loadTerritoryStates(territory.id)).join(", "));
      } else if (territory.scope_type === "zips") {
        setZipsText((await loadTerritoryZips(territory.id)).join("\n"));
      }
    } catch (e) {
      setToast(e.message || "Could not load territory details.");
    }
    setLoading(false);
  }

  async function saveName() {
    if (!name.trim() || name.trim() === territory.name) return;
    setSaving(true);
    try {
      await adminRenameTerritory(territory.id, name.trim());
      setToast("Territory renamed.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not rename this territory.");
    }
    setSaving(false);
  }

  async function saveStates() {
    setSaving(true);
    try {
      const states = statesText.split(",").map(s => s.trim()).filter(Boolean);
      await adminSetTerritoryStates(territory.id, states);
      setToast("Territory states updated.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update states.");
    }
    setSaving(false);
  }

  async function saveZips() {
    setSaving(true);
    try {
      const zips = zipsText.split(/[\s,]+/).map(z => z.trim()).filter(Boolean);
      await adminAssignZipsToTerritory(territory.id, zips);
      setToast("Territory ZIPs updated.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not update ZIPs.");
    }
    setSaving(false);
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await adminDeleteTerritory(territory.id);
      setToast(`${territory.name} deleted.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not delete this territory.");
    }
    setDeleting(false);
    setConfirmingDelete(false);
  }

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, background: C.paper }}>
      <div onClick={toggleExpand} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer" }}>
        <div style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{territory.name}</div>
        <Badge color={C.pineDeep} bg={C.sandWarm}>{SCOPE_LABEL[territory.scope_type] || territory.scope_type}</Badge>
        <span style={{ fontSize: 13, color: C.gray, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
      </div>
      {expanded && (
        <div style={{ padding: "0 12px 12px 12px" }}>
          {loading && <CenteredNote>Loading…</CenteredNote>}
          {!loading && (
            <>
              <Field label="Name" value={name} onChange={setName} />
              <Btn size="sm" full={false} disabled={saving || !name.trim() || name.trim() === territory.name} onClick={saveName}>
                Save name
              </Btn>

              {territory.scope_type === "states" && (
                <div style={{ marginTop: 14 }}>
                  <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>
                    States (comma-separated 2-letter codes)
                  </label>
                  <input value={statesText} onChange={e => setStatesText(e.target.value)} placeholder="IL, IN, WI"
                    style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", marginBottom: 8 }} />
                  <Btn size="sm" full={false} disabled={saving} onClick={saveStates}>Save states</Btn>
                </div>
              )}

              {territory.scope_type === "zips" && (
                <div style={{ marginTop: 14 }}>
                  <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>
                    ZIP codes (one per line, or comma/space-separated)
                  </label>
                  <textarea value={zipsText} onChange={e => setZipsText(e.target.value)} rows={5} placeholder="60491&#10;60467"
                    style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "8px 10px", fontSize: 13, fontFamily: "inherit", marginBottom: 8, resize: "vertical" }} />
                  <Btn size="sm" full={false} disabled={saving} onClick={saveZips}>Save ZIPs</Btn>
                </div>
              )}

              {territory.scope_type === "all" && (
                <div style={{ fontSize: 12, color: C.gray, marginTop: 10 }}>Covers every ZIP nationwide — nothing to configure.</div>
              )}

              <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                {confirmingDelete ? (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11.5, color: C.gray }}>Delete this territory?</span>
                    <Btn size="sm" full={false} variant="danger" disabled={deleting} onClick={doDelete}>Yes</Btn>
                    <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirmingDelete(false)}>No</Btn>
                  </div>
                ) : (
                  <Btn size="sm" full={false} variant="danger" onClick={() => setConfirmingDelete(true)}>Delete territory</Btn>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NewTerritoryForm({ onChanged, setToast }) {
  const [name, setName] = useState("");
  const [scopeType, setScopeType] = useState("zips");
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!name.trim()) { setToast("Enter a territory name."); return; }
    setCreating(true);
    try {
      await adminCreateTerritory(name.trim(), scopeType);
      setToast(`Territory "${name.trim()}" created.`);
      setName("");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not create this territory.");
    }
    setCreating(false);
  }

  return (
    <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep, marginBottom: 10 }}>Create a territory</div>
      <Field label="Name" value={name} onChange={setName} placeholder="Will County, IL" />
      <div style={{ display: "flex", gap: 14, marginBottom: 14, fontSize: 13, flexWrap: "wrap" }}>
        {Object.entries(SCOPE_LABEL).map(([key, label]) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="radio" name="territoryScopeType" checked={scopeType === key} onChange={() => setScopeType(key)} />
            {label}
          </label>
        ))}
      </div>
      <Btn size="sm" full={false} disabled={creating} onClick={create}>{creating ? "Creating…" : "Create territory"}</Btn>
    </div>
  );
}

// Scope narrows over time (per the product decision): start with an "all" or "states" territory,
// later create finer ones and reassign ZIPs/admins into them — scope_type is immutable once a
// territory is created, so "narrowing" always means creating new territories, not editing one.
export function TerritoriesPanel({ territories, onChanged, setToast }) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep, marginBottom: 4 }}>Territories</div>
      <p style={{ fontSize: 12, color: C.gray, marginBottom: 12 }}>
        A territory_admin only sees users, jobs, and disputes inside their assigned territory.
        Assign an admin to one from their row below.
      </p>
      <NewTerritoryForm onChanged={onChanged} setToast={setToast} />
      <div style={{ display: "grid", gap: 8 }}>
        {territories.length === 0 && <CenteredNote>No territories yet — full admins remain unrestricted.</CenteredNote>}
        {territories.map(t => <TerritoryRow key={t.id} territory={t} onChanged={onChanged} setToast={setToast} />)}
      </div>
    </div>
  );
}
