// This codebase's RPCs surface errors as a plain `raise exception '<message>'` string (no JSON
// envelope) — the account-deletion feature adds a lightweight, backward-compatible convention on
// top of that for the handful of RPCs that need a machine-checkable code (e.g.
// ACCOUNT_DELETION_BLOCKED): a leading `CODE_NAME: ` prefix on the message. Every pre-existing,
// unprefixed exception in the app still falls through to `{ code: null, message: error.message }`
// unchanged.
const CODE_PREFIX = /^([A-Z_]+):\s*(.*)$/s;

export function parseRpcError(error) {
  const raw = error?.message || "";
  const match = raw.match(CODE_PREFIX);
  if (match) {
    return { code: match[1], message: match[2] };
  }
  return { code: null, message: raw };
}
