// Provider-agnostic OAuth entry point. Adding Apple later is just another call to
// startOAuthSignIn('apple', role) from a new button — no changes needed here.
//
// Passkeys don't fit this shape (WebAuthn resolves synchronously against an existing account,
// there's no external redirect or role to stash first) — that seam lives in SocialAuthButtons.jsx
// instead, as a comment marking where its button will go.
export const OAUTH_ROLE_KEY = "mtb_oauth_role";

export async function startOAuthSignIn(supabase, provider, role) {
  sessionStorage.setItem(OAUTH_ROLE_KEY, role);
  return supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.origin },
  });
}
