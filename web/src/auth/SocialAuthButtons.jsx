import { C, sans } from "../theme";
import { startOAuthSignIn } from "./socialAuth";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.95v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.03l3-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .95 4.97l3 2.33C4.66 5.17 6.65 3.58 9 3.58Z" />
    </svg>
  );
}

// Ready for whenever the Apple Services ID / key are configured on the Supabase side (see
// supabase/config.toml's [auth.external.apple] block) — flip PROVIDERS below and this renders
// correctly with no further changes.
function AppleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#000" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zm3.593-3.257c.837-1.013 1.402-2.427 1.247-3.831-1.207.052-2.662.805-3.527 1.818-.774.896-1.454 2.336-1.273 3.714 1.338.104 2.715-.688 3.553-1.701z" />
    </svg>
  );
}

// Config-array-driven: adding Apple later is one new entry here, not new structure.
const PROVIDERS = [
  { id: "google", label: "Continue with Google", Icon: GoogleIcon },
  // { id: "apple", label: "Continue with Apple", Icon: AppleIcon },  // uncomment once Supabase's Apple provider is configured
];

export function SocialAuthButtons({ supabase, role, disabled, setToast }) {
  async function handleClick(providerId) {
    const { error } = await startOAuthSignIn(supabase, providerId, role);
    if (error) setToast?.(error.message || "Could not start sign-in.");
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: "grid", gap: 8 }}>
        {PROVIDERS.map(({ id, label, Icon }) => (
          <button key={id} type="button" disabled={disabled} onClick={() => handleClick(id)} style={{
            width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 10, padding: "14px 24px",
            fontSize: 15, fontWeight: 700, color: C.ink, fontFamily: sans,
            cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
          }}>
            <Icon />
            {label}
          </button>
        ))}
        {/* Passkey sign-in seam: once WebAuthn is wired up, a "Sign in with a passkey" button goes
            here — it resolves directly against an existing account, no redirect/role-hint needed. */}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0" }}>
        <div style={{ flex: 1, height: 1, background: C.line }} />
        <span style={{ fontSize: 11.5, color: C.gray }}>or continue with email</span>
        <div style={{ flex: 1, height: 1, background: C.line }} />
      </div>
    </div>
  );
}
