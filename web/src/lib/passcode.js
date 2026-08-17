// Shared passcode rules — used at every signup/reset/change-password/admin-invite entry point so
// they can't drift out of sync with each other.
export const PASSCODE_HINT = "At least 8 characters, including one letter and one number. Case sensitive.";

export function passcodeError(value) {
  const v = value.trim();
  if (v.length < 8) return "Passcode must be at least 8 characters.";
  if (!/[a-zA-Z]/.test(v)) return "Passcode must include at least one letter.";
  if (!/[0-9]/.test(v)) return "Passcode must include at least one number.";
  return null;
}

// Mobile keyboards frequently auto-capitalize the first character of any text field — including
// password-type ones on some Android keyboards — which would otherwise silently turn a correctly
// entered passcode into a mismatch. Forcing the first character lowercase on every keystroke, at
// every entry point (create/reset/change/re-enter), keeps them all consistent with each other so
// this can't cause a login failure. Only the first character is touched; the rest stays fully
// case sensitive.
export function normalizePasscode(value) {
  return value.length > 0 ? value[0].toLowerCase() + value.slice(1) : value;
}
