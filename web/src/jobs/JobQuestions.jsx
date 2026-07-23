import { useEffect, useState } from "react";
import { C, mono } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { supabase } from "../lib/supabaseClient";
import { loadJobQuestions, askJobQuestion, answerJobQuestion, countMyOpenQuestions } from "./data";

const QUESTION_CAP = 300;
const MAX_OPEN_UNANSWERED = 3;

// Loose heuristic for "looks like a street address" — a house number followed by a common
// street-suffix word. Not meant to be precise (a real address parser is overkill for a soft
// nudge), just enough to catch the common case before an answer visible to every bidder goes
// out. Contact info itself gets a real, server-side mask (see mask_contact_info) — this is only
// a client-side heads-up, deliberately not a hard block.
const ADDRESS_HINT = /\b\d+\s+\w+(\s+\w+){0,3}\s+(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|cir|circle)\b/i;

async function attachAskerNames(questions) {
  const haulerIds = [...new Set(questions.filter(q => q.hauler_id).map(q => q.hauler_id))];
  if (haulerIds.length === 0) return questions;
  const { data } = await supabase.from("public_profiles").select("id, business_name, name").in("id", haulerIds);
  const byId = Object.fromEntries((data || []).map(p => [p.id, p.business_name || p.name]));
  return questions.map(q => ({ ...q, askerName: q.hauler_id ? byId[q.hauler_id] : undefined }));
}

function timeAgo(iso) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function JobQuestions({ jobId, viewerRole, haulerId, jobOpen, setToast }) {
  const [questions, setQuestions] = useState(null);
  const [myOpenCount, setMyOpenCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [answerDrafts, setAnswerDrafts] = useState({});
  const [savingAnswer, setSavingAnswer] = useState(null);
  const [editingId, setEditingId] = useState(null);

  const showNames = viewerRole === "customer" || viewerRole === "admin";

  async function reload() {
    const rows = await loadJobQuestions(jobId);
    setQuestions(showNames ? await attachAskerNames(rows) : rows);
    if (viewerRole === "hauler" && haulerId) {
      setMyOpenCount(await countMyOpenQuestions({ jobId, haulerId }));
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await loadJobQuestions(jobId);
        const withNames = showNames ? await attachAskerNames(rows) : rows;
        if (cancelled) return;
        setQuestions(withNames);
        if (viewerRole === "hauler" && haulerId) {
          setMyOpenCount(await countMyOpenQuestions({ jobId, haulerId }));
        }
      } catch {
        if (!cancelled) setQuestions([]);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, viewerRole, haulerId]);

  if (questions === null) return null;
  if (questions.length === 0 && !(viewerRole === "hauler" && jobOpen)) return null;

  async function submitQuestion() {
    if (!draft.trim()) return;
    setAsking(true);
    try {
      await askJobQuestion({ jobId, haulerId, text: draft.trim() });
      setDraft("");
      await reload();
    } catch (e) {
      setToast?.(e.message || "Could not post your question.");
    }
    setAsking(false);
  }

  async function submitAnswer(questionId) {
    const text = (answerDrafts[questionId] || "").trim();
    if (!text) return;
    if (ADDRESS_HINT.test(text)) {
      const proceed = window.confirm(
        "Heads up: your answer is visible to all bidders. Don't include your address or phone — " +
        "your hauler gets those after you accept a bid. Post anyway?"
      );
      if (!proceed) return;
    }
    setSavingAnswer(questionId);
    try {
      await answerJobQuestion({ questionId, answerText: text });
      setAnswerDrafts(d => ({ ...d, [questionId]: "" }));
      setEditingId(null);
      await reload();
    } catch (e) {
      setToast?.(e.message || "Could not post your answer.");
    }
    setSavingAnswer(null);
  }

  const unansweredCount = questions.filter(q => !q.answer).length;

  return (
    <div style={{ marginBottom: 14 }}>
      {questions.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: C.pineDeep }}>Questions ({questions.length})</span>
            {viewerRole !== "hauler" && unansweredCount > 0 && (
              <Badge color={C.amber} bg={C.amberLight}>{unansweredCount} unanswered</Badge>
            )}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {questions.map(q => (
              <div key={q.id} style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: C.gray }}>
                    {showNames ? (q.askerName || "A hauler") : "A hauler"} asked:
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {viewerRole === "admin" && q.flag_type && (
                      <Badge color={q.flag_type === "warned-repeat" ? C.red : C.amber} bg={q.flag_type === "warned-repeat" ? C.redLight : C.amberLight}>
                        {q.flag_type === "warned-repeat" ? "🚩 repeat flag" : "🛡️ flagged"}
                      </Badge>
                    )}
                    <span style={{ fontSize: 10.5, color: C.gray, whiteSpace: "nowrap" }}>{timeAgo(q.created_at)}</span>
                  </span>
                </div>
                <div style={{ fontSize: 13, color: C.ink, marginBottom: q.answer || (viewerRole === "customer" && jobOpen) ? 6 : 0 }}>{q.question}</div>

                {q.answer && editingId !== q.id && (
                  <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 6, marginTop: 2 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: C.teal, marginBottom: 3 }}>Answer:</div>
                    <div style={{ fontSize: 13, color: C.ink }}>{q.answer}</div>
                    {viewerRole === "customer" && jobOpen && (
                      <button onClick={() => { setEditingId(q.id); setAnswerDrafts(d => ({ ...d, [q.id]: q.answer })); }}
                        style={{ background: "none", border: "none", color: C.teal, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0, marginTop: 4 }}>
                        Edit answer
                      </button>
                    )}
                  </div>
                )}

                {viewerRole === "customer" && jobOpen && (!q.answer || editingId === q.id) && (
                  <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 6, marginTop: 2 }}>
                    <textarea
                      value={answerDrafts[q.id] ?? ""}
                      onChange={e => setAnswerDrafts(d => ({ ...d, [q.id]: e.target.value.slice(0, QUESTION_CAP) }))}
                      placeholder="Type your answer — every bidder will see it"
                      rows={2}
                      style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "7px 10px", fontSize: 12.5, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 6 }}
                    />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <span style={{ fontFamily: mono, fontSize: 10.5, color: C.gray }}>{(answerDrafts[q.id] || "").length}/{QUESTION_CAP}</span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {editingId === q.id && (
                          <Btn size="sm" full={false} variant="ghost" onClick={() => setEditingId(null)}>Cancel</Btn>
                        )}
                        <Btn size="sm" full={false} disabled={!(answerDrafts[q.id] || "").trim() || savingAnswer === q.id}
                          onClick={() => submitAnswer(q.id)}>
                          {savingAnswer === q.id ? "Posting…" : "Post answer"}
                        </Btn>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {viewerRole === "hauler" && jobOpen && (
        <div style={{ background: C.sand, border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 12px" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.pineDeep, marginBottom: 6 }}>Ask a question</div>
          {myOpenCount >= MAX_OPEN_UNANSWERED ? (
            <div style={{ fontSize: 11.5, color: C.gray }}>
              You have {MAX_OPEN_UNANSWERED} open questions on this job already — wait for an answer before asking another.
            </div>
          ) : (
            <>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value.slice(0, QUESTION_CAP))}
                placeholder="Ask about scope, access, timing…"
                rows={2}
                style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 6, padding: "7px 10px", fontSize: 12.5, fontFamily: "inherit", outline: "none", resize: "vertical", marginBottom: 6 }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: mono, fontSize: 10.5, color: C.gray }}>{draft.length}/{QUESTION_CAP}</span>
                <Btn size="sm" full={false} disabled={!draft.trim() || asking} onClick={submitQuestion}>
                  {asking ? "Posting…" : "Ask"}
                </Btn>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
