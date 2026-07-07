import { useEffect, useState } from "react";
import { C } from "../theme";
import { Btn } from "../ui/Primitives";
import { loadReviews, submitReview } from "./data";

export function ReviewPanel({ chat, chatId, viewer, setToast }) {
  const [reviews, setReviews] = useState(null);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);

  const refresh = () => loadReviews(chatId).then(rows => {
    setReviews(rows);
    const mine = rows.find(r => r.reviewer_role === viewer);
    setRating(mine?.rating || 0);
    setText(mine?.text || "");
    setEditing(!mine);
  });

  useEffect(() => { refresh(); }, [chatId, viewer]);

  if (!reviews) return null;

  const myReview = reviews.find(r => r.reviewer_role === viewer);
  const otherReview = reviews.find(r => r.reviewer_role !== viewer);
  const otherLabel = viewer === "customer" ? chat.businessName : chat.customerName;

  async function handleSubmit() {
    if (!rating) return;
    try {
      await submitReview({ chatId, reviewerRole: viewer, rating, text });
      await refresh();
      setToast("Review submitted — thanks for the feedback!");
    } catch (e) {
      setToast(e.message || "Could not submit review.");
    }
  }

  return (
    <div style={{ background: C.tealLight, borderBottom: `1px solid ${C.teal}33`, padding: "14px 16px" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.teal, marginBottom: 10 }}>⭐ Job complete — leave your review</div>

      {!editing && myReview ? (
        <div style={{ background: C.paper, borderRadius: 10, padding: "10px 12px", marginBottom: otherReview ? 10 : 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ color: "#E8A23D", fontSize: 13 }}>{"★".repeat(myReview.rating)}{"☆".repeat(5 - myReview.rating)}</span>
            <button onClick={() => setEditing(true)} style={{ background: "none", border: "none", color: C.teal, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>Edit</button>
          </div>
          {myReview.text && <div style={{ fontSize: 12.5, color: C.ink }}>{myReview.text}</div>}
        </div>
      ) : (
        <div style={{ background: C.paper, borderRadius: 10, padding: "12px" }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setRating(n)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: n <= rating ? "#E8A23D" : C.grayLight, padding: 0 }}>★</button>
            ))}
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder={`How was working with ${otherLabel}?`}
            style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 11px", fontSize: 12.5, fontFamily: "inherit", outline: "none", minHeight: 56, resize: "vertical", marginBottom: 8 }} />
          <Btn size="sm" disabled={!rating} onClick={handleSubmit}>Submit review</Btn>
        </div>
      )}

      {otherReview ? (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.gray }}>
          {otherLabel} also left a review {!myReview && "— visible once you submit yours"}.
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.gray }}>{otherLabel} hasn't left a review yet.</div>
      )}
    </div>
  );
}
