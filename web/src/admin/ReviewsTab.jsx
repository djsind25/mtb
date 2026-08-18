import { useState } from "react";
import { C, sans, RADIUS, SHADOW_SM, fullDateLabel } from "../theme";
import { Badge } from "../ui/Primitives";
import { UserLink } from "./UserLink";

const SORTS = {
  newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
  oldest: (a, b) => new Date(a.created_at) - new Date(b.created_at),
  highest: (a, b) => b.rating - a.rating || new Date(b.created_at) - new Date(a.created_at),
  lowest: (a, b) => a.rating - b.rating || new Date(b.created_at) - new Date(a.created_at),
};

function ReviewRow({ review, onViewUser, onViewJob }) {
  const authorId = review.reviewer_role === "customer" ? review.customerId : review.haulerId;
  const authorName = review.reviewer_role === "customer" ? review.customerName : review.haulerName;
  const aboutId = review.reviewer_role === "customer" ? review.haulerId : review.customerId;
  const aboutName = review.reviewer_role === "customer" ? review.haulerName : review.customerName;
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ color: "#E8A23D", fontSize: 15 }}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</span>
          <Badge color={review.reviewer_role === "customer" ? C.teal : C.pine} bg={review.reviewer_role === "customer" ? C.tealLight : C.grayLight}>
            {review.reviewer_role === "customer" ? "From customer" : "From hauler"}
          </Badge>
        </div>
        <div style={{ fontSize: 11, color: C.gray, flexShrink: 0, whiteSpace: "nowrap" }}>{fullDateLabel(review.created_at)}</div>
      </div>

      {review.text && <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.5, marginBottom: 8 }}>{review.text}</div>}

      <div style={{ fontSize: 11.5, color: C.gray, fontFamily: sans }}>
        <UserLink id={authorId} name={authorName} onViewUser={onViewUser} /> reviewed{" "}
        <UserLink id={aboutId} name={aboutName} onViewUser={onViewUser} /> on{" "}
        <button
          onClick={() => onViewJob(review.jobId)}
          style={{ background: "none", border: "none", padding: 0, font: "inherit", color: C.teal, textDecoration: "underline", cursor: "pointer" }}
        >
          {review.jobTitle || "this job"}
        </button>
      </div>
    </div>
  );
}

export function ReviewsTab({ reviews, onViewUser, onViewJob }) {
  const [sortBy, setSortBy] = useState("newest");
  const sorted = [...reviews].sort(SORTS[sortBy]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 12, color: C.gray }}>Sort:</span>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
          border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "6px 9px", fontSize: 12.5,
          fontFamily: "inherit", color: C.ink, background: C.paper,
        }}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="highest">Highest rated</option>
          <option value="lowest">Lowest rated</option>
        </select>
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {sorted.length === 0 && <div style={{ fontSize: 13, color: C.gray, textAlign: "center", padding: 24 }}>No reviews submitted yet.</div>}
        {sorted.map(r => <ReviewRow key={r.id} review={r} onViewUser={onViewUser} onViewJob={onViewJob} />)}
      </div>
    </div>
  );
}
