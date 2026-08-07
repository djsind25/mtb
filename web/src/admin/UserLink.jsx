import { C } from "../theme";

// Shared click-through control for admin queue rows — renders a user's display name as a link
// into their UserReviewPanel (via the passed onViewUser(userId) callback) when both an id and the
// callback are available, otherwise falls back to plain text so callers don't need to branch.
export function UserLink({ id, name, onViewUser, fallback = "—" }) {
  if (!onViewUser || !id) return name || fallback;
  return (
    <button
      onClick={e => { e.stopPropagation(); onViewUser(id); }}
      style={{ background: "none", border: "none", padding: 0, font: "inherit", color: C.teal, textDecoration: "underline", cursor: "pointer" }}
    >
      {name || fallback}
    </button>
  );
}
