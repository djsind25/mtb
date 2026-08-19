// Shortens a full personal name to "First L." — used wherever a customer's name is shown to a
// hauler (or vice versa), so the counterparty never sees more than a first name + last initial,
// even after a bid is accepted. Admin views intentionally bypass this and read the full name
// straight from public_profiles/profiles — this only touches the customer-facing/hauler-facing
// data loaders (chat/data.js, jobs/data.js), not admin/data.js.
export function formatShortName(fullName) {
  if (!fullName) return fullName;
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || fullName;
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
