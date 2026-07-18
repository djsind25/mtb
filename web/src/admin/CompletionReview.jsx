import { useState } from "react";
import { C, mono, nowStr } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { CompletionPhotos } from "../jobs/CompletionPhotos";
import { reviewCompletion } from "./data";

function Row({ chat, onChanged, setToast, readOnly }) {
  const [reviewing, setReviewing] = useState(false);
  const owed = (Number(chat.bid_amount) * 0.9).toFixed(2);

  async function markReviewed() {
    setReviewing(true);
    try {
      await reviewCompletion(chat.job_id);
      setToast("Marked reviewed.");
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not mark reviewed.");
    }
    setReviewing(false);
  }

  return (
    <div style={{ background: C.paper, border: `1px solid ${chat.admin_reviewed_at ? C.line : C.teal + "66"}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{chat.jobTitle || "Job"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            {chat.customerName} → {chat.haulerName} · ZIP {chat.zip || "—"}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${Number(chat.bid_amount).toFixed(2)}</div>
          <div style={{ fontSize: 10.5, color: C.gray }}>hauler owed ${owed} (90%)</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <Badge color={C.teal} bg={C.tealLight}>Hauler done · {nowStr(chat.hauler_done_at)}</Badge>
        {chat.customer_ack_at
          ? <Badge color={C.teal} bg={C.tealLight}>Customer acknowledged · {nowStr(chat.customer_ack_at)}</Badge>
          : <Badge color={C.amber} bg={C.amberLight}>Awaiting customer</Badge>}
        {chat.admin_reviewed_at
          ? <Badge color={C.gray} bg={C.grayLight}>Reviewed</Badge>
          : <Badge color={C.ember} bg={C.emberLight}>Needs review</Badge>}
      </div>

      <CompletionPhotos jobId={chat.job_id} />

      {!chat.admin_reviewed_at && !readOnly && (
        <Btn size="sm" full={false} onClick={markReviewed} disabled={reviewing}>
          {reviewing ? "Marking…" : "Mark reviewed"}
        </Btn>
      )}
    </div>
  );
}

export function CompletionReview({ completedJobs, onChanged, setToast, readOnly }) {
  const needsReview = completedJobs.filter(c => !c.admin_reviewed_at);
  const reviewed = completedJobs.filter(c => c.admin_reviewed_at);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {completedJobs.length === 0 && (
        <div style={{ fontSize: 13, color: C.gray, textAlign: "center", padding: 24 }}>No completed jobs yet.</div>
      )}
      {needsReview.map(c => <Row key={c.id} chat={c} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />)}
      {reviewed.length > 0 && needsReview.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 700, color: C.gray, marginTop: 6 }}>Reviewed</div>
      )}
      {reviewed.map(c => <Row key={c.id} chat={c} onChanged={onChanged} setToast={setToast} readOnly={readOnly} />)}
    </div>
  );
}
