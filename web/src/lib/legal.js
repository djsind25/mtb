import { TOS_VERSION, PRIVACY_VERSION } from "../legal/legalContent";

// Called right after a successful signup/OAuth-completion, and again whenever legal_reaccept
// fires — records both documents at the version currently shipped, as one new append-only row
// each (see 20260812000000_legal_acceptance.sql).
export async function recordLegalAcceptance(supabase) {
  const tos = await supabase.rpc("record_legal_acceptance", { p_document: "tos", p_version: TOS_VERSION });
  if (tos.error) throw tos.error;
  const privacy = await supabase.rpc("record_legal_acceptance", { p_document: "privacy", p_version: PRIVACY_VERSION });
  if (privacy.error) throw privacy.error;
}

// True when the signed-in user still needs to accept — either they never have (any account
// created before this feature shipped), or a version bump since their last acceptance.
export async function needsLegalReaccept(supabase) {
  const { data, error } = await supabase.rpc("has_current_legal_acceptance", {
    p_tos_version: TOS_VERSION, p_privacy_version: PRIVACY_VERSION,
  });
  if (error) throw error;
  return !data;
}

// For the Account tab's "Legal" section — latest accepted row per document, or null if never accepted.
export async function loadMyLegalAcceptances(supabase) {
  const { data, error } = await supabase
    .from("legal_acceptances")
    .select("document, version, accepted_at")
    .order("accepted_at", { ascending: false });
  if (error) throw error;
  const latest = {};
  for (const row of data) {
    if (!latest[row.document]) latest[row.document] = row;
  }
  return latest;
}
