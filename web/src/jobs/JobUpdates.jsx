import { useEffect, useState } from "react";
import { C, mono } from "../theme";
import { Btn } from "../ui/Primitives";
import { loadJobUpdates, postJobUpdate } from "./data";

const UPDATE_CAP = 300;

function timeAgo(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Append-only, customer-authored detail log — no edit/delete, so a correction is a new entry
// rather than rewriting history. Same moderation (mask_contact_info + is_flaggable) as
// JobQuestions' answers, since this is the same "customer text visible to a whole radius of
// bidders" risk profile.
export function JobUpdates({ jobId, viewerRole, jobOpen, setToast }) {
  const [updates, setUpdates] = useState(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  async function reload() {
    setUpdates(await loadJobUpdates(jobId));
  }

  useEffect(() => {
    let cancelled = false;
    loadJobUpdates(jobId).then(rows => { if (!cancelled) setUpdates(rows); }).catch(() => setUpdates([]));
    return () => { cancelled = true; };
  }, [jobId]);

  if (updates === null) return null;
  if (updates.length === 0 && !(viewerRole === "customer" && jobOpen)) return null;

  async function submit() {
    if (!draft.trim()) return;
    setPosting(true);
    try {
      await postJobUpdate({ jobId, text: draft.trim() });
      setDraft("");
      await reload();
    } catch (e) {
      setToast?.(e.message || "Could not post this update.");
    }
    setPosting(false);
  }

  return (
    <div style={{ marginBottom: 14 }}>
      {updates.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep, marginBottom: 8 }}>Updates from the customer</div>
          <div style={{ display: "grid", gap: 6 }}>
            {updates.map(u => (
              <div key={u.id} style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 12px" }}>
                <div style={{ fontSize: 13, color: C.ink, marginBottom: 3 }}>{u.text}</div>
                <div style={{ fontSize: 10.5, color: C.gray }}>{timeAgo(u.created_at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewerRole === "customer" && jobOpen && (
        <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 12px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Add job details</div>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value.slice(0, UPDATE_CAP))}
            placeholder="Add anything you forgot — extra items, access notes, measurements…"
            rows={2}
            style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "7px 10px", fontSize: 12.5, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 6 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: mono, fontSize: 10.5, color: C.gray }}>{draft.length}/{UPDATE_CAP}</span>
            <Btn size="sm" full={false} disabled={!draft.trim() || posting} onClick={submit}>
              {posting ? "Posting…" : "Add"}
            </Btn>
          </div>
          <div style={{ fontSize: 10, color: C.gray, marginTop: 4 }}>Visible to every bidder — this is a running log, not an edit to your original post.</div>
        </div>
      )}
    </div>
  );
}
