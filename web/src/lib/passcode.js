// Shared passcode rules — used at every signup/reset/change-password/admin-invite entry point so
// they can't drift out of sync with each other.
export function passcodeError(value) {
  const v = value.trim();
  if (v.length < 8) return "Passcode must be at least 8 characters.";
  if (!/[a-zA-Z]/.test(v)) return "Passcode must include at least one letter.";
  if (!/[0-9]/.test(v)) return "Passcode must include at least one number.";
  return null;
}

// Same three rules as passcodeError, broken out per-criterion for a live checklist under the
// field (Field's `checklist` prop) instead of one static hint — mirrors passcodeError exactly,
// so a criterion never shows "met" here while still failing the real check on submit.
export function passcodeChecklist(value) {
  const v = value.trim();
  return [
    { label: "At least 8 characters", met: v.length >= 8 },
    { label: "Includes a letter", met: /[a-zA-Z]/.test(v) },
    { label: "Includes a number", met: /[0-9]/.test(v) },
  ];
}
