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
