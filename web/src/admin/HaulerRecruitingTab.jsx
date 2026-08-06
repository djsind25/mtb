import { useEffect, useState } from "react";
import { C, sans, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn, Field, CenteredNote } from "../ui/Primitives";
import {
  createRecruitingLead, updateRecruitingLead, loadRecruitingLeadActivity, addRecruitingLeadNote,
  linkRecruitingLead, unlinkRecruitingLead, searchHaulerAccounts,
} from "./data";

const STAGES = ["to_contact", "contacted", "interested", "signed_up", "verified", "active", "not_interested", "dormant"];
const STAGE_LABELS = {
  to_contact: "To contact", contacted: "Contacted", interested: "Interested", signed_up: "Signed up",
  verified: "Verified", active: "Active", not_interested: "Not interested", dormant: "Dormant",
};
const STAGE_COLORS = {
  to_contact: C.gray, contacted: C.teal, interested: C.amber, signed_up: C.pine,
  verified: C.pine, active: C.pine, not_interested: C.red, dormant: C.gray,
};
const inputStyle = { border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, fontFamily: sans, color: C.ink, width: "100%", boxSizing: "border-box" };

function NewLeadForm({ onCreated, setToast }) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState({ business_name: "", contact_name: "", phone: "", email: "", zip: "", source: "", notes: "" });
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!fields.business_name.trim()) { setToast("Business name is required."); return; }
    setSaving(true);
    try {
      await createRecruitingLead(fields);
      setFields({ business_name: "", contact_name: "", phone: "", email: "", zip: "", source: "", notes: "" });
      setOpen(false);
      setToast("Lead added.");
      onCreated();
    } catch (e) {
      setToast(e.message || "Could not add this lead.");
    }
    setSaving(false);
  }

  if (!open) return <Btn full={false} onClick={() => setOpen(true)}>+ Add recruiting lead</Btn>;

  return (
    <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, padding: 14, marginBottom: 14 }}>
      <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
        <Field label="Business name" value={fields.business_name} onChange={v => setFields(f => ({ ...f, business_name: v }))} required />
        <Field label="Contact name" value={fields.contact_name} onChange={v => setFields(f => ({ ...f, contact_name: v }))} />
        <Field label="Phone" value={fields.phone} onChange={v => setFields(f => ({ ...f, phone: v }))} type="tel" />
        <Field label="Email" value={fields.email} onChange={v => setFields(f => ({ ...f, email: v }))} type="email" />
        <Field label="ZIP / service area" value={fields.zip} onChange={v => setFields(f => ({ ...f, zip: v }))} />
        <Field label="Source" value={fields.source} onChange={v => setFields(f => ({ ...f, source: v }))} placeholder="How I found them" />
        <Field label="Notes" value={fields.notes} onChange={v => setFields(f => ({ ...f, notes: v }))} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" full={false} onClick={() => setOpen(false)}>Cancel</Btn>
        <Btn full={false} onClick={save} disabled={saving}>{saving ? "Adding…" : "Add lead"}</Btn>
      </div>
    </div>
  );
}

function LinkPicker({ lead, onChanged, setToast }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [linking, setLinking] = useState(false);

  async function search(q) {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      setResults(await searchHaulerAccounts(q));
    } catch {
      setResults([]);
    }
    setSearching(false);
  }

  async function link(haulerId) {
    setLinking(true);
    try {
      await linkRecruitingLead(lead.id, haulerId);
      setToast("Linked to real hauler account.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not link this account.");
    }
    setLinking(false);
  }

  return (
    <div style={{ marginTop: 8 }}>
      <input style={inputStyle} placeholder="Search haulers by name or email…" value={query} onChange={e => search(e.target.value)} />
      {searching && <div style={{ fontSize: 11.5, color: C.gray, marginTop: 4 }}>Searching…</div>}
      {results.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {results.map(r => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}>
              <div style={{ fontSize: 12.5, color: C.ink }}>{r.business_name || r.name} <span style={{ color: C.gray }}>· {r.email}</span></div>
              <Btn size="sm" full={false} onClick={() => link(r.id)} disabled={linking}>Link</Btn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LeadDetail({ lead, onChanged, setToast, readOnly }) {
  const [fields, setFields] = useState({
    business_name: lead.business_name || "", contact_name: lead.contact_name || "", phone: lead.phone || "",
    email: lead.email || "", zip: lead.zip || "", source: lead.source || "", notes: lead.notes || "",
    stage: lead.stage, last_contacted_at: lead.last_contacted_at || "", next_followup_at: lead.next_followup_at || "",
  });
  const [saving, setSaving] = useState(false);
  const [activity, setActivity] = useState(null);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);

  useEffect(() => {
    loadRecruitingLeadActivity(lead.id).then(setActivity).catch(() => setActivity([]));
  }, [lead.id]);

  async function save() {
    setSaving(true);
    try {
      await updateRecruitingLead(lead.id, {
        ...fields,
        last_contacted_at: fields.last_contacted_at || null,
        next_followup_at: fields.next_followup_at || null,
      });
      setToast("Lead updated.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not save this lead.");
    }
    setSaving(false);
  }

  async function submitNote() {
    if (!newNote.trim()) return;
    setAddingNote(true);
    try {
      await addRecruitingLeadNote(lead.id, newNote);
      setNewNote("");
      setActivity(await loadRecruitingLeadActivity(lead.id));
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not add that note.");
    }
    setAddingNote(false);
  }

  async function unlink() {
    try {
      await unlinkRecruitingLead(lead.id);
      setToast("Unlinked.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not unlink.");
    }
  }

  return (
    <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 10, paddingTop: 10, display: "grid", gap: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <Field label="Business name" value={fields.business_name} onChange={v => setFields(f => ({ ...f, business_name: v }))} required />
        <Field label="Contact name" value={fields.contact_name} onChange={v => setFields(f => ({ ...f, contact_name: v }))} />
        <Field label="Phone" value={fields.phone} onChange={v => setFields(f => ({ ...f, phone: v }))} type="tel" />
        <Field label="Email" value={fields.email} onChange={v => setFields(f => ({ ...f, email: v }))} type="email" />
        <Field label="ZIP / service area" value={fields.zip} onChange={v => setFields(f => ({ ...f, zip: v }))} />
        <Field label="Source" value={fields.source} onChange={v => setFields(f => ({ ...f, source: v }))} />
      </div>
      <Field label="Notes" value={fields.notes} onChange={v => setFields(f => ({ ...f, notes: v }))} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <div>
          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Stage</label>
          <select value={fields.stage} onChange={e => setFields(f => ({ ...f, stage: e.target.value }))} style={inputStyle}>
            {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </div>
        <Field label="Last contacted" value={fields.last_contacted_at} onChange={v => setFields(f => ({ ...f, last_contacted_at: v }))} type="date" />
        <Field label="Next follow-up" value={fields.next_followup_at} onChange={v => setFields(f => ({ ...f, next_followup_at: v }))} type="date" />
      </div>

      {!readOnly && <Btn full={false} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Btn>}

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Real account</div>
        {lead.linked_hauler_id ? (
          <div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Badge color={C.pine} bg={C.tealLight}>
                Linked{lead.linkedHaulerStatus ? ` · ${lead.linkedHaulerStatus.verified ? "verified" : "not verified"}` : ""}
              </Badge>
              {!readOnly && <Btn size="sm" full={false} variant="ghost" onClick={unlink}>Unlink</Btn>}
            </div>
          </div>
        ) : !readOnly ? (
          showLinkPicker ? (
            <LinkPicker lead={lead} onChanged={onChanged} setToast={setToast} />
          ) : (
            <Btn size="sm" full={false} variant="ghost" onClick={() => setShowLinkPicker(true)}>Link to a real hauler account</Btn>
          )
        ) : (
          <div style={{ fontSize: 11.5, color: C.gray }}>Not yet linked.</div>
        )}
      </div>

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Activity log</div>
        {!readOnly && (
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input style={inputStyle} placeholder="e.g. Called 7/28, left voicemail" value={newNote} onChange={e => setNewNote(e.target.value)} />
            <Btn size="sm" full={false} onClick={submitNote} disabled={addingNote}>Add</Btn>
          </div>
        )}
        {activity === null ? null : activity.length === 0 ? (
          <div style={{ fontSize: 11.5, color: C.gray }}>No activity logged yet.</div>
        ) : (
          <div style={{ display: "grid", gap: 4 }}>
            {activity.map(a => (
              <div key={a.id} style={{ fontSize: 11.5, color: C.ink }}>
                <span style={{ color: C.gray }}>{new Date(a.created_at).toLocaleDateString()}</span> — {a.note}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LeadRow({ lead, onChanged, setToast, readOnly }) {
  const [expanded, setExpanded] = useState(false);
  const overdue = lead.next_followup_at && new Date(lead.next_followup_at) < new Date(new Date().toDateString());

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ cursor: "pointer" }} onClick={() => setExpanded(v => !v)}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{lead.business_name}</div>
            <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
              {lead.contact_name}{lead.zip ? ` · ZIP ${lead.zip}` : ""}{lead.phone ? ` · ${lead.phone}` : ""}
            </div>
          </div>
          <span style={{ fontSize: 13, color: C.gray, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <Badge color={STAGE_COLORS[lead.stage]} bg={C.grayLight}>{STAGE_LABELS[lead.stage]}</Badge>
          {lead.next_followup_at && (
            <Badge color={overdue ? C.red : C.gray} bg={overdue ? C.redLight : C.grayLight}>
              {overdue ? "⚠ Follow up " : "Follow up "}{new Date(lead.next_followup_at).toLocaleDateString()}
            </Badge>
          )}
          {lead.linked_hauler_id && <Badge color={C.pine} bg={C.tealLight}>Linked to account</Badge>}
        </div>
      </div>
      {expanded && <LeadDetail lead={lead} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />}
    </div>
  );
}

export function HaulerRecruitingTab({ leads, onChanged, setToast, readOnly }) {
  const [stageFilter, setStageFilter] = useState("all");
  const stageCounts = Object.fromEntries(STAGES.map(s => [s, leads.filter(l => l.stage === s).length]));
  const visible = stageFilter === "all" ? leads : leads.filter(l => l.stage === stageFilter);

  return (
    <div>
      {!readOnly && <NewLeadForm onCreated={onChanged} setToast={setToast} />}
      <div style={{ display: "flex", gap: 6, margin: "14px 0", flexWrap: "wrap" }}>
        <button onClick={() => setStageFilter("all")} style={{
          background: stageFilter === "all" ? C.pine : C.paper, color: stageFilter === "all" ? C.paper : C.ink,
          border: `1px solid ${stageFilter === "all" ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
          fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
        }}>All ({leads.length})</button>
        {STAGES.map(s => (
          <button key={s} onClick={() => setStageFilter(s)} style={{
            background: stageFilter === s ? C.pine : C.paper, color: stageFilter === s ? C.paper : C.ink,
            border: `1px solid ${stageFilter === s ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
            fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>{STAGE_LABELS[s]} ({stageCounts[s]})</button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {visible.length === 0 && <CenteredNote>No recruiting leads {stageFilter === "all" ? "yet" : "in this stage"}.</CenteredNote>}
        {visible.map(l => <LeadRow key={l.id} lead={l} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />)}
      </div>
    </div>
  );
}
