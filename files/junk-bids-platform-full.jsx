import { useState, useEffect, useRef, useCallback } from "react";

// ─── Design tokens (MyTrashBid brand) ─────────────────────────────────────────
// Palette pulled from the MyTrashBid logo: vivid grass green + deep charcoal on clean white.
const C = {
  pine: "#41A62E", pineDeep: "#16232D",        // pine -> primary green; pineDeep -> charcoal (headlines/dark UI)
  ember: "#41A62E", emberLight: "#E9F6E6",     // ember (old accent) -> green so CTAs match brand
  sand: "#F6F8F5", sandWarm: "#EDF2EA",        // bright neutral bg instead of warm sand
  teal: "#2E7D22", tealLight: "#E2F2DE",       // teal -> deep green accent
  ink: "#16232D", paper: "#FFFFFF", gray: "#5E6B63", grayLight: "#E4E9E3",
  line: "#D8E0D6", amber: "#B8860B", amberLight: "#FBF3DD", red: "#C0392B", redLight: "#FBEAE8",
  green: "#41A62E", greenDeep: "#2E7D22", charcoal: "#16232D",
};
const serif = "'Fraunces', Georgia, serif";
const sans = "'Inter', system-ui, sans-serif";
const mono = "'JetBrains Mono', monospace";

const ADMIN_EMAIL = "admin@mytrashbid.com";
const ADMIN_PASSCODE = "991122";

// ─── Storage helpers ─────────────────────────────────────────────────────────
async function safeGet(key, shared = true) {
  try {
    const r = await window.storage.get(key, shared);
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}
async function safeSet(key, value, shared = true) {
  try {
    await window.storage.set(key, JSON.stringify(value), shared);
    return true;
  } catch {
    return false;
  }
}
async function safeList(prefix, shared = true) {
  try {
    const r = await window.storage.list(prefix, shared);
    return r?.keys || [];
  } catch {
    return [];
  }
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function nowStr() {
  return new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ─── 14-day live window helpers ───────────────────────────────────────────────
const LIVE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const COMPLETION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days to confirm job complete
const MAX_RADIUS_MI = 50; // haulers only see jobs within this distance of their service ZIP

// ─── Payment model ────────────────────────────────────────────────────────────
// "deposit": customer prepays a 10% deposit (our fee); pays the 90% balance directly
//            to the hauler at completion (off-platform). This is the launch model.
// "full":    customer pays the full amount through MyTrashBid; we hold it, release the
//            90% to the hauler on completion, keep 10%. Requires Stripe Connect backend.
// The per-job `paymentMode` field overrides this default, so full-payment can later be
// switched on globally, per-job, or offered as a customer choice — without re-architecting.
const DEFAULT_PAYMENT_MODE = "deposit";
const COMMISSION_RATE = 0.10;

// Single source of truth for the money split on any bid amount.
function priceBreakdown(bidAmount, paymentMode = DEFAULT_PAYMENT_MODE) {
  const amount = Number(bidAmount) || 0;
  const fee = +(amount * COMMISSION_RATE).toFixed(2);        // MyTrashBid's 10%
  const depositNow = +(amount * COMMISSION_RATE).toFixed(2); // what the customer pays up front
  const balanceDue = +(amount - depositNow).toFixed(2);      // remainder
  return {
    amount,
    fee,                                  // always our revenue
    depositNow,                           // charged at acceptance
    balanceDue,                           // the 90%
    paymentMode,
    // where the balance goes:
    balancePaidTo: paymentMode === "full" ? "platform" : "hauler-direct",
    // whether the platform ever touches the full amount:
    platformProcessesFull: paymentMode === "full",
  };
}

// ─── ZIP → approx centroid (lat, lng) for distance matching ───────────────────
// Will County, IL launch market + surrounding ZIPs. In production this is replaced
// by a full ZIP geo database or a geocoding API call at signup time.
const ZIP_GEO = {
  "60491": [41.609, -87.961], // Homer Glen
  "60441": [41.589, -88.041], // Lockport
  "60446": [41.626, -88.078], // Romeoville
  "60439": [41.679, -87.987], // Lemont
  "60462": [41.627, -87.857], // Orland Park
  "60467": [41.600, -87.886], // Orland Park (W)
  "60448": [41.668, -87.939], // Mokena
  "60417": [41.510, -87.671], // Crete
  "60451": [41.516, -87.965], // New Lenox
  "60432": [41.530, -88.069], // Joliet (E)
  "60435": [41.546, -88.122], // Joliet (W)
  "60403": [41.561, -88.133], // Crest Hill
  "60404": [41.451, -88.198], // Shorewood
  "60544": [41.604, -88.205], // Plainfield
  "60564": [41.717, -88.201], // Naperville (S)
  "60565": [41.733, -88.133], // Naperville
  "60585": [41.681, -88.234], // Plainfield (N)
  "60490": [41.703, -88.111], // Bolingbrook (S)
  "60440": [41.700, -88.068], // Bolingbrook
  "60525": [41.789, -87.881], // La Grange
  "60453": [41.717, -87.751], // Oak Lawn
  "60477": [41.573, -87.794], // Tinley Park
  "60487": [41.555, -87.823], // Tinley Park (S)
  "60406": [41.658, -87.737], // Blue Island
  "60411": [41.508, -87.611], // Chicago Heights
  "60466": [41.476, -87.692], // Park Forest
  "60423": [41.481, -87.832], // Frankfort
  "60619": [41.745, -87.605], // Chicago (S side, edge of radius)
  "60606": [41.882, -87.638], // Chicago (Loop)
};

// Haversine distance in miles between two [lat,lng] points
function milesBetween(a, b) {
  if (!a || !b) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8; // earth radius in miles
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Distance between two ZIPs; null if either ZIP isn't in our geo table
function zipDistanceMi(zipA, zipB) {
  const a = ZIP_GEO[String(zipA || "").trim()];
  const b = ZIP_GEO[String(zipB || "").trim()];
  if (!a || !b) return null;
  return milesBetween(a, b);
}

function isExpired(expiresAtMs) {
  return !!expiresAtMs && Date.now() > expiresAtMs;
}
function daysLeft(expiresAtMs) {
  if (!expiresAtMs) return null;
  const ms = expiresAtMs - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
function expiryLabel(expiresAtMs) {
  if (isExpired(expiresAtMs)) return "Expired";
  const d = daysLeft(expiresAtMs);
  if (d === 0) return "Expires today";
  if (d === 1) return "1 day left";
  return `${d} days left`;
}

// ─── Flagging logic ──────────────────────────────────────────────────────────
function isFlaggable(text) {
  const patterns = [
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
    /\bcash\b/i,
    /\bvenmo|zelle|paypal|cashapp\b/i,
    /\bcall me\b/i,
    /\btext me\b/i,
    /off.?the.?app/i,
    /off.?platform/i,
  ];
  return patterns.some(p => p.test(text));
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────
function Btn({ children, onClick, disabled, variant = "primary", size = "md", full = true, type = "button" }) {
  const bg = disabled ? C.grayLight
    : variant === "primary" ? C.ember
    : variant === "dark" ? C.pine
    : variant === "teal" ? C.teal
    : variant === "danger" ? C.red
    : "transparent";
  const color = disabled ? C.gray : variant === "ghost" ? C.pine : C.paper;
  const border = variant === "ghost" ? `1.5px solid ${C.line}` : "none";
  return (
    <button type={type} onClick={disabled ? undefined : onClick} style={{
      width: full ? "100%" : "auto", background: bg, color, border, borderRadius: 10,
      padding: size === "lg" ? "14px 24px" : size === "sm" ? "8px 14px" : "11px 18px",
      fontSize: size === "lg" ? 15 : size === "sm" ? 12.5 : 14, fontWeight: 700,
      cursor: disabled ? "not-allowed" : "pointer", fontFamily: sans, transition: "filter 0.15s",
    }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.filter = "brightness(1.08)"; }}
      onMouseLeave={e => { e.currentTarget.style.filter = ""; }}
    >{children}</button>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, required, hint }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {label && <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>{label}{required && <span style={{ color: C.red }}> *</span>}</label>}
      <input
        type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{
          width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8,
          padding: "10px 13px", fontSize: 14, fontFamily: sans, outline: "none", color: C.ink, background: C.paper,
        }}
      />
      {hint && <div style={{ fontSize: 11, color: C.gray, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Badge({ children, color = C.teal, bg = C.tealLight }) {
  return <span style={{ fontSize: 10.5, fontWeight: 700, color, background: bg, borderRadius: 20, padding: "3px 9px", letterSpacing: "0.02em" }}>{children}</span>;
}

function Avatar({ emoji, size = 36, bg = C.grayLight }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, flexShrink: 0 }}>{emoji}</div>;
}

// ─── Brand logo mark (green dumpster + checkmark + $ pin) ─────────────────────
function LogoMark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" style={{ flexShrink: 0 }} aria-label="MyTrashBid">
      {/* dollar pin */}
      <circle cx="37" cy="9" r="7.5" fill={C.green} />
      <path d="M37 16.5 L33.5 12 L40.5 12 Z" fill={C.green} />
      <text x="37" y="12.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff" fontFamily="Inter, sans-serif">$</text>
      {/* lid */}
      <rect x="5" y="15" width="34" height="6" rx="1.5" fill={C.charcoal} />
      {/* body */}
      <path d="M8 21 H36 L33.5 39 H10.5 Z" fill={C.green} />
      {/* wheels */}
      <circle cx="14" cy="41.5" r="2.4" fill={C.charcoal} />
      <circle cx="30" cy="41.5" r="2.4" fill={C.charcoal} />
      {/* checkmark circle */}
      <circle cx="22" cy="30" r="7" fill="#fff" />
      <path d="M18.5 30 L21 32.5 L26 27" stroke={C.green} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
function Wordmark({ size = 17 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <LogoMark size={size + 9} />
      <span style={{ fontFamily: sans, fontWeight: 800, fontSize: size, letterSpacing: "-0.02em" }}>
        <span style={{ color: C.charcoal }}>MyTrash</span><span style={{ color: C.green }}>Bid</span>
      </span>
    </div>
  );
}

function TopBar({ session, onLogout, onNav, page }) {
  return (
    <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 18px", position: "sticky", top: 0, zIndex: 50 }}>
      <div style={{ maxWidth: 880, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Wordmark size={17} />
        </div>
        {session && (
          <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
            {session.role !== "admin" && (
              <NavTab label="Jobs" active={page === "jobs"} onClick={() => onNav("jobs")} />
            )}
            {session.role !== "admin" && (
              <NavTab label="Chats" active={page === "chats"} onClick={() => onNav("chats")} />
            )}
            {session.role === "admin" && (
              <NavTab label="Admin Dashboard" active={page === "admin"} onClick={() => onNav("admin")} />
            )}
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          {session && (
            <>
              <span style={{ fontSize: 12.5, color: C.gray }}>
                {session.role === "admin" ? "🛡️ Admin" : session.role === "hauler" ? "🚛 " + session.businessName : "👤 " + session.name}
              </span>
              <Btn size="sm" full={false} variant="ghost" onClick={onLogout}>Log out</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
function NavTab({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.sandWarm : "transparent", border: "none", borderRadius: 7,
      padding: "7px 13px", fontSize: 13, fontWeight: 600, color: active ? C.pineDeep : C.gray,
      cursor: "pointer", fontFamily: sans,
    }}>{label}</button>
  );
}

// ─── AUTH: Landing / role select ──────────────────────────────────────────────
function AuthLanding({ onPick }) {
  return (
    <div style={{ minHeight: "100vh", background: C.sandWarm, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: sans }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <LogoMark size={64} />
          </div>
          <div style={{ fontFamily: sans, fontWeight: 800, fontSize: 30, letterSpacing: "-0.02em", marginBottom: 6 }}>
            <span style={{ color: C.charcoal }}>MyTrash</span><span style={{ color: C.green }}>Bid</span>
          </div>
          <div style={{ fontSize: 15, color: C.charcoal, fontWeight: 600 }}>Snap. <span style={{ color: C.green }}>Get Bids.</span> Trash Gone.</div>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <RoleCard
            icon="👤" title="I'm a customer" desc="Post a job or rent a dumpster"
            onClick={() => onPick("customer")}
          />
          <RoleCard
            icon="🚛" title="I'm a hauler / dumpster rental business" desc="Bid on jobs, manage your profile"
            onClick={() => onPick("hauler")}
          />
        </div>

        <div style={{ textAlign: "center", marginTop: 24 }}>
          <button onClick={() => onPick("admin")} style={{ background: "none", border: "none", color: C.gray, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
            Admin login
          </button>
        </div>
      </div>
    </div>
  );
}
function RoleCard({ icon, title, desc, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: C.paper, border: `1.5px solid ${C.line}`, borderRadius: 14, padding: "20px",
      display: "flex", alignItems: "center", gap: 14, cursor: "pointer", textAlign: "left", fontFamily: sans,
      transition: "border-color 0.15s",
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = C.teal}
      onMouseLeave={e => e.currentTarget.style.borderColor = C.line}
    >
      <div style={{ fontSize: 28 }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.pineDeep, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: C.gray }}>{desc}</div>
      </div>
      <div style={{ color: C.gray }}>→</div>
    </button>
  );
}

// ─── AUTH: signup/login forms ────────────────────────────────────────────────
function AuthForm({ role, onBack, onAuthed, setToast }) {
  const [mode, setMode] = useState("login"); // login | signup
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // shared
  const [email, setEmail] = useState("");
  const [passcode, setPasscode] = useState("");
  // customer signup
  const [name, setName] = useState("");
  const [zip, setZip] = useState("");
  // hauler signup
  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [serviceZip, setServiceZip] = useState("");

  // admin
  const [adminPass, setAdminPass] = useState("");

  async function handleAdminLogin() {
    setError("");
    if (email.trim().toLowerCase() === ADMIN_EMAIL && adminPass === ADMIN_PASSCODE) {
      onAuthed({ role: "admin", email: ADMIN_EMAIL });
    } else {
      setError("Incorrect admin email or passcode.");
    }
  }

  async function handleLogin() {
    setError("");
    if (!email.trim() || !passcode.trim()) { setError("Enter your email and passcode."); return; }
    setLoading(true);
    const userKeys = await safeList("users:");
    let found = null;
    for (const k of userKeys) {
      const u = await safeGet(k.key || k);
      if (u && u.email.toLowerCase() === email.trim().toLowerCase() && u.role === role) {
        found = u; break;
      }
    }
    setLoading(false);
    if (!found) { setError("No account found for that email under this role."); return; }
    if (found.passcode !== passcode.trim()) { setError("Incorrect passcode."); return; }
    onAuthed(found);
  }

  async function handleSignup() {
    setError("");
    if (role === "customer") {
      if (!name.trim() || !email.trim() || !passcode.trim() || !zip.trim()) { setError("Fill in all fields."); return; }
    } else {
      if (!businessName.trim() || !contactName.trim() || !email.trim() || !passcode.trim() || !serviceZip.trim()) { setError("Fill in all fields."); return; }
    }
    if (passcode.trim().length < 4) { setError("Passcode must be at least 4 digits/characters."); return; }

    setLoading(true);
    // check existing
    const userKeys = await safeList("users:");
    for (const k of userKeys) {
      const u = await safeGet(k.key || k);
      if (u && u.email.toLowerCase() === email.trim().toLowerCase() && u.role === role) {
        setLoading(false);
        setError("An account with this email already exists for this role.");
        return;
      }
    }

    const id = uid("user");
    const baseUser = {
      id, role, email: email.trim(), passcode: passcode.trim(), createdAt: nowStr(),
    };
    const user = role === "customer"
      ? { ...baseUser, name: name.trim(), zip: zip.trim(), avatar: "👤" }
      : { ...baseUser, businessName: businessName.trim(), name: contactName.trim(), zip: serviceZip.trim(), avatar: "🚛", verified: false, rating: null };

    await safeSet(`users:${id}`, user);
    setLoading(false);
    setToast(`Welcome to MyTrashBid, ${role === "customer" ? user.name : user.businessName}!`);
    onAuthed(user);
  }

  if (role === "admin") {
    return (
      <AuthShell title="Admin login" subtitle="Restricted access" onBack={onBack}>
        <Field label="Admin email" value={email} onChange={setEmail} placeholder="admin@mytrashbid.com" />
        <Field label="Passcode" value={adminPass} onChange={setAdminPass} type="password" placeholder="••••••" />
        {error && <ErrorMsg>{error}</ErrorMsg>}
        <Btn onClick={handleAdminLogin} size="lg" variant="dark">Enter dashboard</Btn>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={role === "customer" ? "Customer account" : "Hauler account"}
      subtitle={mode === "login" ? "Welcome back" : "Let's get you set up"}
      onBack={onBack}
    >
      <div style={{ display: "flex", gap: 6, marginBottom: 20, background: C.sandWarm, borderRadius: 9, padding: 3 }}>
        {["login", "signup"].map(m => (
          <button key={m} onClick={() => { setMode(m); setError(""); }} style={{
            flex: 1, padding: "8px", borderRadius: 6, border: "none", cursor: "pointer",
            background: mode === m ? C.paper : "transparent", fontWeight: 700, fontSize: 13,
            color: mode === m ? C.pineDeep : C.gray, fontFamily: sans,
          }}>{m === "login" ? "Log in" : "Sign up"}</button>
        ))}
      </div>

      {mode === "login" && (
        <>
          <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@email.com" required />
          <Field label="Passcode" value={passcode} onChange={setPasscode} type="password" placeholder="••••••" required />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleLogin} disabled={loading} size="lg">{loading ? "Checking…" : "Log in"}</Btn>
        </>
      )}

      {mode === "signup" && role === "customer" && (
        <>
          <Field label="Full name" value={name} onChange={setName} placeholder="Dave K." required />
          <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="you@email.com" required />
          <Field label="ZIP code" value={zip} onChange={setZip} placeholder="60491" required />
          <Field label="Create a passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 4 characters" required hint="Demo-only passcode, not a secure password." />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleSignup} disabled={loading} size="lg">{loading ? "Creating account…" : "Create account"}</Btn>
        </>
      )}

      {mode === "signup" && role === "hauler" && (
        <>
          <Field label="Business name" value={businessName} onChange={setBusinessName} placeholder="Capital City Haulers" required />
          <Field label="Contact name" value={contactName} onChange={setContactName} placeholder="Jake Torres" required />
          <Field label="Business email" value={email} onChange={setEmail} type="email" placeholder="jake@capitalcityhaul.com" required />
          <Field label="Primary service ZIP" value={serviceZip} onChange={setServiceZip} placeholder="60491" required />
          <Field label="Create a passcode" value={passcode} onChange={setPasscode} type="password" placeholder="At least 4 characters" required hint="Demo-only passcode, not a secure password." />
          {error && <ErrorMsg>{error}</ErrorMsg>}
          <Btn onClick={handleSignup} disabled={loading} size="lg">{loading ? "Creating account…" : "Apply as a hauler"}</Btn>
        </>
      )}
    </AuthShell>
  );
}
function AuthShell({ title, subtitle, onBack, children }) {
  return (
    <div style={{ minHeight: "100vh", background: C.sandWarm, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: sans }}>
      <div style={{ width: "100%", maxWidth: 400, background: C.paper, borderRadius: 16, padding: 28, border: `1px solid ${C.line}` }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: C.gray, fontSize: 13, cursor: "pointer", marginBottom: 14 }}>← Back</button>
        <div style={{ fontFamily: serif, fontSize: 22, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: 13, color: C.gray, marginBottom: 20 }}>{subtitle}</div>
        {children}
      </div>
    </div>
  );
}
function ErrorMsg({ children }) {
  return <div style={{ fontSize: 12.5, color: C.red, background: C.redLight, borderRadius: 8, padding: "8px 12px", marginBottom: 14 }}>⚠ {children}</div>;
}

// ─── JOBS: list + post + bid ──────────────────────────────────────────────────
function JobsPage({ session, setToast, onOpenChat }) {
  const [jobs, setJobs] = useState([]);
  const [showPost, setShowPost] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadJobs = useCallback(async () => {
    setLoading(true);
    const keys = await safeList("jobs:");
    const loaded = [];
    for (const k of keys) {
      const j = await safeGet(k.key || k);
      if (j) loaded.push(j);
    }
    loaded.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    setJobs(loaded);
    setLoading(false);
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  async function postJob(form) {
    const id = uid("job");
    const createdAtMs = Date.now();
    const job = {
      id, title: form.title, description: form.description, zip: form.zip,
      photoCount: form.photoCount || 0, photoNames: form.photoNames || [],
      customerId: session.id, customerName: session.name,
      status: "open", bids: [], acceptedBidId: null,
      createdAt: nowStr(), createdAtMs, expiresAtMs: createdAtMs + LIVE_WINDOW_MS,
    };
    await safeSet(`jobs:${id}`, job);
    setShowPost(false);
    setToast("Job posted! Vetted haulers nearby will start bidding — most jobs get their first bid within 24 hours. This post stays live for 14 days.");
    loadJobs();
  }

  async function renewJob(jobId) {
    const job = await safeGet(`jobs:${jobId}`);
    if (!job) return;
    const createdAtMs = Date.now();
    job.createdAtMs = createdAtMs;
    job.expiresAtMs = createdAtMs + LIVE_WINDOW_MS;
    job.createdAt = nowStr();
    await safeSet(`jobs:${jobId}`, job);
    setToast("Job renewed — live for another 14 days.");
    loadJobs();
  }

  async function submitBid(jobId, amount, note) {
    const keys = await safeList("jobs:");
    const job = await safeGet(`jobs:${jobId}`);
    if (!job) return;
    const createdAtMs = Date.now();
    const bid = {
      id: uid("bid"), haulerId: session.id, businessName: session.businessName,
      amount: Number(amount), note, createdAt: nowStr(),
      createdAtMs, expiresAtMs: createdAtMs + LIVE_WINDOW_MS,
    };
    job.bids = [...(job.bids || []), bid];
    await safeSet(`jobs:${jobId}`, job);
    setToast("Bid submitted! It stays open for the customer to accept for 14 days.");
    loadJobs();
  }

  async function renewBid(jobId, bidId) {
    const job = await safeGet(`jobs:${jobId}`);
    if (!job) return;
    const createdAtMs = Date.now();
    job.bids = job.bids.map(b => b.id === bidId
      ? { ...b, createdAtMs, expiresAtMs: createdAtMs + LIVE_WINDOW_MS, createdAt: nowStr() }
      : b);
    await safeSet(`jobs:${jobId}`, job);
    setToast("Bid renewed — live for another 14 days.");
    loadJobs();
  }

  async function acceptBid(jobId, bidId) {
    const job = await safeGet(`jobs:${jobId}`);
    if (!job) return;
    const acceptedAtMs = Date.now();
    // paymentMode resolves from the job (if set), else the global default.
    const paymentMode = job.paymentMode || DEFAULT_PAYMENT_MODE;
    job.status = "booked";
    job.acceptedBidId = bidId;
    job.acceptedAtMs = acceptedAtMs;
    job.completeByMs = acceptedAtMs + COMPLETION_WINDOW_MS;
    job.completed = false;
    job.completedAtMs = null;
    job.paymentMode = paymentMode;
    await safeSet(`jobs:${jobId}`, job);

    // create chat thread
    const bid = job.bids.find(b => b.id === bidId);
    const chatId = `chat_${jobId}`;
    const existing = await safeGet(`chats:${chatId}`);
    if (!existing) {
      const pb = priceBreakdown(bid.amount, paymentMode);
      const lockMsg = pb.paymentMode === "full"
        ? `Job locked in! $${pb.amount} paid through MyTrashBid and held securely. $${pb.balanceDue} releases to your hauler when the job is confirmed complete.`
        : `Job locked in! $${pb.depositNow} deposit paid to MyTrashBid. The remaining $${pb.balanceDue} is paid directly to your hauler at completion.`;
      await safeSet(`chats:${chatId}`, {
        id: chatId, jobId, jobTitle: job.title,
        customerId: job.customerId, customerName: job.customerName,
        haulerId: bid.haulerId, businessName: bid.businessName,
        bidAmount: bid.amount, deposit: pb.depositNow, balanceDue: pb.balanceDue,
        commission: pb.fee, commissionStatus: "held", paymentMode: pb.paymentMode,
        messages: [{ id: uid("msg"), sender: "system", type: "system", text: lockMsg, time: nowStr() }],
      });
      await registerChatIndex(chatId);
    }
    const pbToast = priceBreakdown(bid.amount, paymentMode);
    setToast(pbToast.paymentMode === "full"
      ? `Job locked in! $${pbToast.amount} held securely. Chat unlocked.`
      : `Job locked in for $${pbToast.depositNow} deposit! Chat unlocked. $${pbToast.balanceDue} due to your hauler at completion.`);
    loadJobs();
  }

  async function confirmJobComplete(jobId) {
    const job = await safeGet(`jobs:${jobId}`);
    if (!job) return;
    job.completed = true;
    job.completedAtMs = Date.now();
    await safeSet(`jobs:${jobId}`, job);

    // deposit (our fee) is finalized; balance was paid directly to hauler. Unlock reviews.
    const chatId = `chat_${jobId}`;
    const chat = await safeGet(`chats:${chatId}`);
    if (chat) {
      chat.commissionStatus = "earned";
      chat.reviewsUnlocked = true;
      chat.messages = [...chat.messages, { id: uid("msg"), sender: "system", type: "system", text: `Job confirmed complete. Make sure the $${(chat.balanceDue ?? 0).toFixed(2)} balance was settled directly with your hauler. Both sides can now leave a review.`, time: nowStr() }];
      await safeSet(`chats:${chatId}`, chat);
    }
    setToast("Job marked complete! Review form unlocked for both sides.");
    loadJobs();
  }

  if (loading) return <CenteredNote>Loading jobs…</CenteredNote>;

  const myJobs = session.role === "customer" ? jobs.filter(j => j.customerId === session.id) : [];

  // Hauler open jobs: within MAX_RADIUS_MI of the hauler's service ZIP.
  // Jobs whose ZIP we can't geocode are still shown (fail-open) but flagged distance-unknown.
  const openForBidding = session.role === "hauler"
    ? jobs
        .filter(j => j.status === "open" && !isExpired(j.expiresAtMs))
        .map(j => ({ ...j, _distanceMi: zipDistanceMi(session.zip, j.zip) }))
        .filter(j => j._distanceMi === null || j._distanceMi <= MAX_RADIUS_MI)
        .sort((a, b) => (a._distanceMi ?? 999) - (b._distanceMi ?? 999))
    : [];
  const outOfRangeCount = session.role === "hauler"
    ? jobs.filter(j => j.status === "open" && !isExpired(j.expiresAtMs))
        .filter(j => { const d = zipDistanceMi(session.zip, j.zip); return d !== null && d > MAX_RADIUS_MI; }).length
    : 0;

  const myBidJobs = session.role === "hauler" ? jobs.filter(j => (j.bids || []).some(b => b.haulerId === session.id)) : [];

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      {session.role === "customer" && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h2 style={{ fontFamily: serif, fontSize: 22, color: C.pineDeep, margin: 0 }}>Your jobs</h2>
            <Btn full={false} size="sm" onClick={() => setShowPost(true)}>+ Post a job</Btn>
          </div>
          {showPost && <PostJobForm onCancel={() => setShowPost(false)} onSubmit={postJob} />}
          {myJobs.length === 0 && !showPost && <CenteredNote>No jobs yet — post one to get started.</CenteredNote>}
          <div style={{ display: "grid", gap: 12 }}>
            {myJobs.map(job => (
              <CustomerJobCard key={job.id} job={job} onAccept={acceptBid} onOpenChat={onOpenChat} onRenewJob={renewJob} />
            ))}
          </div>
        </>
      )}

      {session.role === "hauler" && (
        <>
          <h2 style={{ fontFamily: serif, fontSize: 22, color: C.pineDeep, marginBottom: 4 }}>Open jobs near you</h2>
          <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 18 }}>
            Showing jobs within {MAX_RADIUS_MI} miles of your service ZIP ({session.zip || "not set"}). Posts stay live for 14 days unless renewed.
          </p>
          <div style={{ display: "grid", gap: 12, marginBottom: outOfRangeCount ? 12 : 32 }}>
            {openForBidding.length === 0 && <CenteredNote>No open jobs within {MAX_RADIUS_MI} miles right now. Check back soon.</CenteredNote>}
            {openForBidding.map(job => (
              <HaulerJobCard key={job.id} job={job} session={session} onBid={submitBid} />
            ))}
          </div>
          {outOfRangeCount > 0 && (
            <p style={{ fontSize: 12, color: C.gray, marginBottom: 32, textAlign: "center" }}>
              {outOfRangeCount} more open job{outOfRangeCount !== 1 ? "s" : ""} outside your {MAX_RADIUS_MI}-mile range (not shown).
            </p>
          )}

          <h2 style={{ fontFamily: serif, fontSize: 18, color: C.pineDeep, marginBottom: 12 }}>Your bids</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {myBidJobs.length === 0 && <CenteredNote>You haven't submitted any bids yet.</CenteredNote>}
            {myBidJobs.map(job => (
              <HaulerBidStatusCard key={job.id} job={job} session={session} onOpenChat={onOpenChat} onRenewBid={renewBid} onConfirmComplete={confirmJobComplete} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CenteredNote({ children }) {
  return <div style={{ textAlign: "center", color: C.gray, fontSize: 13, padding: "30px 0" }}>{children}</div>;
}

function PostJobForm({ onCancel, onSubmit }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [zip, setZip] = useState("");
  const [photos, setPhotos] = useState([]); // [{ name, url }]
  const fileInputRef = useRef(null);

  function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/"));
    const newPhotos = files.map(f => ({ name: f.name, url: URL.createObjectURL(f) }));
    setPhotos(p => [...p, ...newPhotos]);
  }
  function removePhoto(idx) {
    setPhotos(p => {
      const copy = [...p];
      URL.revokeObjectURL(copy[idx].url);
      copy.splice(idx, 1);
      return copy;
    });
  }

  const canSubmit = title && zip && photos.length > 0;

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: 18, marginBottom: 16 }}>
      <Field label="Job title" value={title} onChange={setTitle} placeholder="Old couch + mattresses" required />

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Description</label>
        <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="What needs to go, roughly how much, any access notes…"
          style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "10px 13px", fontSize: 14, fontFamily: sans, outline: "none", minHeight: 80, resize: "vertical" }} />
        <div style={{ fontSize: 11.5, color: C.teal, marginTop: 5, display: "flex", gap: 5 }}>
          <span>📏</span>
          <span>Tip: approximate measurements (e.g. "couch is about 7ft long") help haulers bid accurately.</span>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>
          Photos <span style={{ color: C.red }}>*</span> <span style={{ fontWeight: 400, color: C.gray }}>— at least 1 required</span>
        </label>
        <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={e => { handleFiles(e.target.files); e.target.value = ""; }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {photos.map((p, i) => (
            <div key={i} style={{ position: "relative", width: 64, height: 64 }}>
              <img src={p.url} alt={p.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: `1px solid ${C.line}` }} />
              <button onClick={() => removePhoto(i)} style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: C.red, color: C.paper, border: "none", fontSize: 11, cursor: "pointer" }}>×</button>
            </div>
          ))}
          <button onClick={() => fileInputRef.current?.click()} style={{
            width: 64, height: 64, borderRadius: 8, border: `2px dashed ${C.line}`, background: "none",
            cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            color: C.gray, fontSize: 18,
          }}>
            <span>+</span>
            <span style={{ fontSize: 9 }}>Add</span>
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6 }}>
          Photos display for you on this device for this session. (Prototype limitation: there's no real file storage here, so haulers and admin will see "photo attached" rather than the image itself.)
        </div>
      </div>

      <Field label="ZIP code" value={zip} onChange={setZip} placeholder="60491" required />
      <div style={{ display: "flex", gap: 8 }}>
        <Btn variant="ghost" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!canSubmit} onClick={() => onSubmit({ title, description, zip, photoCount: photos.length, photoNames: photos.map(p => p.name) })}>Post job</Btn>
      </div>
    </div>
  );
}

function CustomerJobCard({ job, onAccept, onOpenChat, onRenewJob }) {
  const [expanded, setExpanded] = useState(false);
  const bids = job.bids || [];
  const jobExpired = job.status === "open" && isExpired(job.expiresAtMs);
  return (
    <div style={{ background: C.paper, border: `1px solid ${jobExpired ? C.amber + "66" : C.line}`, borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => setExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", padding: 16, textAlign: "left", cursor: "pointer", fontFamily: sans }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14.5, color: C.pineDeep, marginBottom: 4 }}>{job.title}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Badge color={job.status === "open" ? C.ember : C.teal} bg={job.status === "open" ? C.emberLight : C.tealLight}>
                {job.status === "open" ? `${bids.length} bid${bids.length !== 1 ? "s" : ""}` : "Booked"}
              </Badge>
              {job.status === "open" && (
                <Badge color={jobExpired ? C.red : C.gray} bg={jobExpired ? C.redLight : C.grayLight}>
                  {expiryLabel(job.expiresAtMs)}
                </Badge>
              )}
              <span style={{ fontSize: 11.5, color: C.gray }}>{job.createdAt}</span>
            </div>
          </div>
          <span style={{ color: C.gray }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: 16 }}>
          {job.status === "booked" ? (
            <div>
              <div style={{ fontSize: 13, color: C.teal, fontWeight: 700, marginBottom: 6 }}>✓ Locked in — deposit paid</div>
              <div style={{ marginBottom: 10 }}>
                {job.completed ? (
                  <Badge color={C.teal} bg={C.tealLight}>✓ Hauler confirmed complete — leave a review in chat</Badge>
                ) : (
                  <Badge color={C.gray} bg={C.grayLight}>Pay the balance directly to your hauler at completion</Badge>
                )}
              </div>
              <Btn variant="teal" onClick={() => onOpenChat(`chat_${job.id}`)}>Open chat</Btn>
            </div>
          ) : jobExpired ? (
            <div>
              <div style={{ fontSize: 13, color: C.red, fontWeight: 600, marginBottom: 12 }}>
                ⚠ This job listing expired 14 days after posting and is no longer visible to haulers for new bids.
                {bids.length > 0 && " Bids already placed below may still be accepted if they haven't expired themselves."}
              </div>
              <Btn variant="dark" onClick={() => onRenewJob(job.id)}>Renew job listing — 14 more days</Btn>
              {bids.length > 0 && (
                <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
                  {bids.map(bid => <BidRow key={bid.id} bid={bid} jobId={job.id} onAccept={onAccept} paymentMode={job.paymentMode} />)}
                </div>
              )}
            </div>
          ) : bids.length === 0 ? (
            <CenteredNote>Waiting on bids — most jobs get their first one within 24 hours. This listing stays live for 14 days.</CenteredNote>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              {bids.map(bid => <BidRow key={bid.id} bid={bid} jobId={job.id} onAccept={onAccept} paymentMode={job.paymentMode} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BidRow({ bid, jobId, onAccept, paymentMode }) {
  const bidExpired = isExpired(bid.expiresAtMs);
  const pb = priceBreakdown(bid.amount, paymentMode || DEFAULT_PAYMENT_MODE);
  const isFull = pb.paymentMode === "full";
  return (
    <div style={{ border: `1px solid ${bidExpired ? C.amber + "66" : C.line}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 13.5, color: C.pineDeep }}>{bid.businessName}</span>
        <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${bid.amount}</span>
      </div>
      {bid.note && <div style={{ fontSize: 12.5, color: C.gray, marginBottom: 8 }}>"{bid.note}"</div>}
      <div style={{ marginBottom: 10 }}>
        <Badge color={bidExpired ? C.red : C.gray} bg={bidExpired ? C.redLight : C.grayLight}>{expiryLabel(bid.expiresAtMs)}</Badge>
      </div>
      {bidExpired ? (
        <div style={{ fontSize: 12, color: C.red }}>This bid expired and can no longer be accepted. The hauler can renew it to reopen it.</div>
      ) : isFull ? (
        <>
          <div style={{ background: C.sand, borderRadius: 8, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ color: C.gray }}>Pay now through MyTrashBid (held securely)</span>
              <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${pb.amount.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.gray }}>Released to hauler on completion</span>
              <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${pb.balanceDue.toFixed(2)}</span>
            </div>
          </div>
          <Btn size="sm" onClick={() => onAccept(jobId, bid.id)}>Pay ${pb.amount.toFixed(2)} & lock in (protected)</Btn>
          <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6, textAlign: "center" }}>
            Your money is held by MyTrashBid and only released to the hauler once you confirm the job's done.
          </div>
        </>
      ) : (
        <>
          <div style={{ background: C.sand, borderRadius: 8, padding: "9px 11px", marginBottom: 10, fontSize: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ color: C.gray }}>Pay now to lock in (10% deposit)</span>
              <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${pb.depositNow.toFixed(2)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: C.gray }}>Pay hauler at completion</span>
              <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${pb.balanceDue.toFixed(2)}</span>
            </div>
          </div>
          <Btn size="sm" onClick={() => onAccept(jobId, bid.id)}>Lock in job for ${pb.depositNow.toFixed(2)} deposit</Btn>
          <div style={{ fontSize: 10.5, color: C.gray, marginTop: 6, textAlign: "center" }}>
            The ${pb.balanceDue.toFixed(2)} balance is paid directly to your hauler — cash, check, or their preferred method.
          </div>
        </>
      )}
    </div>
  );
}

function HaulerJobCard({ job, session, onBid }) {
  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const alreadyBid = (job.bids || []).some(b => b.haulerId === session.id);
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
      <button onClick={() => setExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", padding: 16, textAlign: "left", cursor: "pointer", fontFamily: sans }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14.5, color: C.pineDeep, marginBottom: 4 }}>{job.title}</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11.5, color: C.gray }}>📍 ZIP {job.zip} · {(job.bids || []).length} bids so far · {job.createdAt}</span>
              <Badge color={C.gray} bg={C.grayLight}>{expiryLabel(job.expiresAtMs)}</Badge>
              {typeof job._distanceMi === "number" && <Badge color={C.teal} bg={C.tealLight}>📏 {job._distanceMi < 1 ? "<1" : Math.round(job._distanceMi)} mi away</Badge>}
              {job._distanceMi === null && <Badge color={C.gray} bg={C.grayLight}>Distance unknown</Badge>}
              {job.photoCount > 0 && <Badge color={C.teal} bg={C.tealLight}>📷 {job.photoCount} photo{job.photoCount !== 1 ? "s" : ""} attached</Badge>}
            </div>
          </div>
          <span style={{ color: C.gray }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: 16 }}>
          <p style={{ fontSize: 13, color: C.gray, marginBottom: 14, lineHeight: 1.5 }}>{job.description || "No description provided."}</p>
          {alreadyBid ? (
            <Badge color={C.teal} bg={C.tealLight}>✓ You already bid on this job</Badge>
          ) : (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <Field label="Your bid ($)" value={amount} onChange={setAmount} type="number" placeholder="175" />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: C.ink, marginBottom: 5 }}>Message to customer</label>
                <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Why pick you?" style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "10px 13px", fontSize: 13.5, fontFamily: sans, outline: "none", minHeight: 60, resize: "vertical" }} />
              </div>
              <div style={{ fontSize: 11, color: C.gray, marginBottom: 10 }}>Your bid stays open for the customer to accept for 14 days, unless you renew it.</div>
              <Btn disabled={!amount} onClick={() => onBid(job.id, amount, note)}>Submit bid</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HaulerBidStatusCard({ job, session, onOpenChat, onRenewBid, onConfirmComplete }) {
  const myBid = (job.bids || []).find(b => b.haulerId === session.id);
  const won = job.status === "booked" && job.acceptedBidId === myBid?.id;
  const lost = job.status === "booked" && job.acceptedBidId !== myBid?.id;
  const pending = (!job.status || job.status === "open");
  const bidExpired = pending && isExpired(myBid?.expiresAtMs);

  const completionOverdue = won && !job.completed && isExpired(job.completeByMs);
  const completionDaysLeft = won && !job.completed ? daysLeft(job.completeByMs) : null;

  return (
    <div style={{ background: C.paper, border: `1px solid ${bidExpired || completionOverdue ? C.amber + "66" : C.line}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{job.title}</span>
        <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${myBid?.amount}</span>
      </div>
      {won && (
        <div style={{ fontSize: 11, color: C.gray, marginBottom: 8 }}>
          You collect <strong style={{ color: C.pineDeep }}>${(myBid.amount * 0.9).toFixed(2)}</strong> directly from the customer at completion (they prepaid the ${(myBid.amount * 0.1).toFixed(2)} platform deposit).
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {won && job.completed && <Badge color={C.teal} bg={C.tealLight}>✓ Job complete</Badge>}
        {won && !job.completed && <Badge color={C.teal} bg={C.tealLight}>✓ You won this job</Badge>}
        {lost && <Badge color={C.gray} bg={C.grayLight}>Customer chose another hauler</Badge>}
        {pending && !bidExpired && <Badge color={C.ember} bg={C.emberLight}>Pending — awaiting customer decision</Badge>}
        {bidExpired && <Badge color={C.red} bg={C.redLight}>Bid expired — no longer acceptable</Badge>}
        {pending && <Badge color={C.gray} bg={C.grayLight}>{expiryLabel(myBid?.expiresAtMs)}</Badge>}
        {won && !job.completed && !completionOverdue && <Badge color={C.gray} bg={C.grayLight}>Confirm within {completionDaysLeft} day{completionDaysLeft !== 1 ? "s" : ""}</Badge>}
        {completionOverdue && <Badge color={C.red} bg={C.redLight}>⚠ 30-day window passed — please confirm</Badge>}
      </div>

      {bidExpired && (
        <Btn size="sm" variant="dark" onClick={() => onRenewBid(job.id, myBid.id)}>Renew bid — 14 more days</Btn>
      )}

      {won && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <Btn size="sm" variant="teal" full={false} onClick={() => onOpenChat(`chat_${job.id}`)}>Open chat</Btn>
          {!job.completed && (
            <Btn size="sm" full={false} variant={completionOverdue ? "danger" : "primary"} onClick={() => onConfirmComplete(job.id)}>
              ✓ Confirm job complete
            </Btn>
          )}
        </div>
      )}
      {completionOverdue && (
        <div style={{ fontSize: 11, color: "#8A6604", background: C.amberLight, borderRadius: 8, padding: "8px 10px", marginTop: 8, lineHeight: 1.5 }}>
          🔔 Reminder: it's been over 30 days since this job was booked. Please confirm completion so the customer can leave a review and your commission can finalize. This has also been flagged for our team to follow up.
        </div>
      )}
    </div>
  );
}

// ─── Chat index helper (so admin / chats list can discover threads) ──────────
async function registerChatIndex(chatId) {
  const idx = (await safeGet("chat-index")) || [];
  if (!idx.includes(chatId)) {
    idx.push(chatId);
    await safeSet("chat-index", idx);
  }
}

// ─── CHATS list page ──────────────────────────────────────────────────────────
function ChatsListPage({ session, onOpenChat }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const idx = (await safeGet("chat-index")) || [];
      const loaded = [];
      for (const cid of idx) {
        const c = await safeGet(`chats:${cid}`);
        if (c && (c.customerId === session.id || c.haulerId === session.id)) loaded.push(c);
      }
      setChats(loaded);
      setLoading(false);
    })();
  }, [session.id]);

  if (loading) return <CenteredNote>Loading chats…</CenteredNote>;

  return (
    <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px 60px" }}>
      <h2 style={{ fontFamily: serif, fontSize: 22, color: C.pineDeep, marginBottom: 16 }}>Your chats</h2>
      {chats.length === 0 && <CenteredNote>No active chats yet. Chats unlock once a bid is accepted.</CenteredNote>}
      <div style={{ display: "grid", gap: 10 }}>
        {chats.map(c => {
          const other = session.role === "customer" ? c.businessName : c.customerName;
          const lastMsg = c.messages?.[c.messages.length - 1];
          return (
            <button key={c.id} onClick={() => onOpenChat(c.id)} style={{
              background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14,
              display: "flex", gap: 12, alignItems: "center", cursor: "pointer", textAlign: "left", fontFamily: sans,
            }}>
              <Avatar emoji={session.role === "customer" ? "🚛" : "👤"} bg={session.role === "customer" ? C.tealLight : C.sandWarm} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{other}</div>
                <div style={{ fontSize: 12, color: C.gray, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.jobTitle}</div>
              </div>
              <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: C.teal }}>${c.bidAmount}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── CHAT thread view ──────────────────────────────────────────────────────────
function ChatThread({ chatId, session, onClose, setToast }) {
  const [chat, setChat] = useState(null);
  const [draft, setDraft] = useState("");
  const [bannerExpanded, setBannerExpanded] = useState(false);
  const scrollRef = useRef(null);

  const load = useCallback(async () => {
    const c = await safeGet(`chats:${chatId}`);
    setChat(c);
  }, [chatId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [chat?.messages?.length]);

  if (!chat) return <CenteredNote>Loading chat…</CenteredNote>;

  const viewer = session.role; // "customer" | "hauler"
  const myPastFlags = (chat.messages || []).filter(m => m.sender === viewer && (m.type === "warned" || m.type === "warned-repeat")).length;

  async function send() {
    if (!draft.trim()) return;
    const flagged = isFlaggable(draft);
    let type = undefined;
    if (flagged) type = myPastFlags >= 1 ? "warned-repeat" : "warned";

    const msg = { id: uid("msg"), sender: viewer, text: draft, time: nowStr(), ...(type ? { type } : {}) };
    const updated = { ...chat, messages: [...chat.messages, msg] };
    setChat(updated);
    await safeSet(`chats:${chatId}`, updated);
    setDraft("");

    if (flagged) {
      // log to flagged queue for admin
      const flagLog = (await safeGet("flagged-messages")) || [];
      flagLog.push({
        id: msg.id, chatId, jobTitle: chat.jobTitle, sender: viewer,
        senderName: viewer === "customer" ? chat.customerName : chat.businessName,
        text: draft, time: nowStr(), severity: type,
      });
      await safeSet("flagged-messages", flagLog);
    }
  }

  const otherName = viewer === "customer" ? chat.businessName : chat.customerName;
  const otherIsBiz = viewer === "customer";
  const deposit = chat.deposit ?? +(chat.bidAmount * 0.10).toFixed(2);
  const balanceDue = chat.balanceDue ?? +(chat.bidAmount - deposit).toFixed(2);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "16px 16px 0", display: "flex", flexDirection: "column", height: "calc(100vh - 64px)" }}>
      <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 13, cursor: "pointer", marginBottom: 10, textAlign: "left" }}>← Back to chats</button>

      <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 14, flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar emoji={otherIsBiz ? "🚛" : "👤"} bg={otherIsBiz ? C.tealLight : C.sandWarm} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep }}>{otherName}</div>
            <div style={{ fontSize: 11, color: C.gray }}>{chat.jobTitle}</div>
          </div>
          <Badge color={C.gray} bg={C.grayLight}>🛡️ Monitored</Badge>
        </div>

        <div style={{ background: C.amberLight, borderBottom: `1px solid ${C.amber}33`, padding: bannerExpanded ? "12px 16px" : "9px 16px" }}>
          <button onClick={() => setBannerExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0, fontFamily: sans, textAlign: "left" }}>
            <span>🛡️</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#8A6604", flex: 1 }}>This chat is monitored to keep the platform fair</span>
            <span style={{ fontSize: 11, color: "#8A6604" }}>{bannerExpanded ? "▲" : "▼"}</span>
          </button>
          {bannerExpanded && (
            <div style={{ fontSize: 12, color: "#6B5103", lineHeight: 1.55, marginTop: 8, paddingLeft: 22 }}>
              Paying your hauler the remaining balance directly is expected and fine. What we do flag is sharing contact info to arrange jobs <em>outside</em> MyTrashBid to skip the deposit that keeps this service running. First mentions send with a warning; repeated attempts are flagged for Trust &amp; Safety review.
            </div>
          )}
        </div>

        <div style={{ background: C.sand, padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}>
          {(chat.paymentMode === "full") ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontFamily: mono, fontSize: 17, fontWeight: 700, color: C.pineDeep }}>${chat.bidAmount} total</span>
                <Badge color={C.teal} bg={C.tealLight}>🔒 Held by MyTrashBid</Badge>
              </div>
              <div style={{ fontSize: 11.5, color: C.gray, display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span>MyTrashBid fee (10%)</span>
                <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${deposit.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.gray, display: "flex", justifyContent: "space-between" }}>
                <span>{viewer === "hauler" ? "Released to you on completion" : "Released to hauler on completion"}</span>
                <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${balanceDue.toFixed(2)}</span>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontFamily: mono, fontSize: 17, fontWeight: 700, color: C.pineDeep }}>${chat.bidAmount} total</span>
                <Badge color={C.teal} bg={C.tealLight}>✓ Deposit paid</Badge>
              </div>
              <div style={{ fontSize: 11.5, color: C.gray, display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span>Deposit paid to MyTrashBid (10%)</span>
                <span style={{ fontFamily: mono, fontWeight: 700, color: C.teal }}>${deposit.toFixed(2)}</span>
              </div>
              <div style={{ fontSize: 11.5, color: C.gray, display: "flex", justifyContent: "space-between" }}>
                <span>{viewer === "hauler" ? "You collect directly at completion" : "Pay hauler directly at completion"}</span>
                <span style={{ fontFamily: mono, fontWeight: 700, color: C.pineDeep }}>${balanceDue.toFixed(2)}</span>
              </div>
            </>
          )}
        </div>

        {chat.reviewsUnlocked && (
          <ReviewPanel chat={chat} chatId={chatId} viewer={viewer} setChat={setChat} setToast={setToast} />
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
          {chat.messages.map(m => <ChatBubble key={m.id} msg={m} viewer={viewer} chat={chat} />)}
        </div>

        <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 12px" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Message about this job…" rows={1}
              style={{ flex: 1, resize: "none", border: `1.5px solid ${C.line}`, borderRadius: 20, padding: "9px 15px", fontSize: 13.5, fontFamily: sans, outline: "none", color: C.ink, background: C.sand }} />
            <button onClick={send} disabled={!draft.trim()} style={{
              width: 36, height: 36, borderRadius: "50%", flexShrink: 0, border: "none",
              cursor: draft.trim() ? "pointer" : "default", background: draft.trim() ? C.ember : C.grayLight,
              color: C.paper, fontSize: 14,
            }}>➤</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ msg, viewer, chat }) {
  if (msg.type === "system") {
    return <div style={{ textAlign: "center", margin: "12px 0" }}><span style={{ fontSize: 11, color: C.teal, background: C.tealLight, borderRadius: 20, padding: "5px 12px", fontWeight: 600 }}>✓ {msg.text}</span></div>;
  }
  const isSelf = msg.sender === viewer;
  const isCustomer = msg.sender === "customer";
  const isWarned = msg.type === "warned" || msg.type === "warned-repeat";
  const isRepeat = msg.type === "warned-repeat";
  return (
    <div style={{ display: "flex", justifyContent: isSelf ? "flex-end" : "flex-start", margin: "4px 14px", gap: 8 }}>
      {!isSelf && <Avatar emoji={isCustomer ? "👤" : "🚛"} size={26} bg={isCustomer ? C.sandWarm : C.tealLight} />}
      <div style={{ maxWidth: "74%" }}>
        <div style={{
          background: isSelf ? (isRepeat ? "#7A2E25" : C.pine) : (isRepeat ? C.redLight : C.paper),
          color: isSelf ? C.paper : C.ink,
          border: isWarned ? `1.5px solid ${isRepeat ? C.red : C.amber}` : (isSelf ? "none" : `1px solid ${C.line}`),
          borderRadius: 16, borderBottomRightRadius: isSelf ? 4 : 16, borderBottomLeftRadius: isSelf ? 16 : 4,
          padding: "9px 13px", fontSize: 13.5, lineHeight: 1.5,
        }}>{msg.text}</div>
        {isWarned && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, justifyContent: isSelf ? "flex-end" : "flex-start" }}>
            <span style={{ fontSize: 10 }}>{isRepeat ? "🚩" : "🛡️"}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: isRepeat ? C.red : "#8A6604" }}>
              {isRepeat ? "Repeated attempt — flagged for Trust & Safety review" : "Flagged for sharing contact/payment info off-platform"}
            </span>
          </div>
        )}
        <div style={{ fontSize: 10, color: C.gray, marginTop: 2, textAlign: isSelf ? "right" : "left" }}>{msg.time}</div>
      </div>
    </div>
  );
}

function ReviewPanel({ chat, chatId, viewer, setChat, setToast }) {
  const myReview = viewer === "customer" ? chat.customerReview : chat.haulerReview;
  const [rating, setRating] = useState(myReview?.rating || 0);
  const [text, setText] = useState(myReview?.text || "");
  const [editing, setEditing] = useState(!myReview);

  async function submitReview() {
    if (!rating) return;
    const review = { rating, text, submittedAt: nowStr() };
    const updated = { ...chat, [viewer === "customer" ? "customerReview" : "haulerReview"]: review };
    setChat(updated);
    await safeSet(`chats:${chatId}`, updated);
    setEditing(false);
    setToast("Review submitted — thanks for the feedback!");
  }

  const otherReview = viewer === "customer" ? chat.haulerReview : chat.customerReview;
  const otherLabel = viewer === "customer" ? chat.businessName : chat.customerName;

  return (
    <div style={{ background: C.tealLight, borderBottom: `1px solid ${C.teal}33`, padding: "14px 16px" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: C.teal, marginBottom: 10 }}>⭐ Job complete — leave your review</div>

      {!editing && myReview ? (
        <div style={{ background: C.paper, borderRadius: 10, padding: "10px 12px", marginBottom: otherReview ? 10 : 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ color: "#E8A23D", fontSize: 13 }}>{"★".repeat(myReview.rating)}{"☆".repeat(5 - myReview.rating)}</span>
            <button onClick={() => setEditing(true)} style={{ background: "none", border: "none", color: C.teal, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>Edit</button>
          </div>
          {myReview.text && <div style={{ fontSize: 12.5, color: C.ink }}>{myReview.text}</div>}
        </div>
      ) : (
        <div style={{ background: C.paper, borderRadius: 10, padding: "12px" }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onClick={() => setRating(n)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: n <= rating ? "#E8A23D" : C.grayLight, padding: 0 }}>★</button>
            ))}
          </div>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder={`How was working with ${otherLabel}?`}
            style={{ width: "100%", boxSizing: "border-box", border: `1.5px solid ${C.line}`, borderRadius: 8, padding: "8px 11px", fontSize: 12.5, fontFamily: sans, outline: "none", minHeight: 56, resize: "vertical", marginBottom: 8 }} />
          <Btn size="sm" disabled={!rating} onClick={submitReview}>Submit review</Btn>
        </div>
      )}

      {otherReview ? (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.gray }}>
          {otherLabel} also left a review {!myReview && "— visible once you submit yours"}.
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.gray }}>{otherLabel} hasn't left a review yet.</div>
      )}
    </div>
  );
}

// ─── ADMIN dashboard ──────────────────────────────────────────────────────────
function AdminDashboard() {
  const [tab, setTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [flags, setFlags] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const userKeys = await safeList("users:");
    const u = [];
    for (const k of userKeys) { const v = await safeGet(k.key || k); if (v) u.push(v); }

    const jobKeys = await safeList("jobs:");
    const j = [];
    for (const k of jobKeys) { const v = await safeGet(k.key || k); if (v) j.push(v); }

    const f = (await safeGet("flagged-messages")) || [];

    setUsers(u); setJobs(j); setFlags(f);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  if (loading) return <CenteredNote>Loading admin dashboard…</CenteredNote>;

  const customers = users.filter(u => u.role === "customer");
  const haulers = users.filter(u => u.role === "hauler");
  const bookedJobs = jobs.filter(j => j.status === "booked");
  const totalGMV = bookedJobs.reduce((sum, j) => {
    const bid = (j.bids || []).find(b => b.id === j.acceptedBidId);
    return sum + (bid?.amount || 0);
  }, 0);
  // Revenue = the 10% deposit MyTrashBid collects. The other 90% goes hauler-direct (off-platform).
  const depositCollected = +(totalGMV * 0.10).toFixed(2);            // what we actually collect
  const haulerDirectVolume = +(totalGMV * 0.90).toFixed(2);         // paid hauler-direct, not ours
  const overdueJobs = bookedJobs.filter(j => !j.completed && isExpired(j.completeByMs));

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "20px 16px 60px" }}>
      <h2 style={{ fontFamily: serif, fontSize: 24, color: C.pineDeep, marginBottom: 4 }}>🛡️ Admin dashboard</h2>
      <p style={{ fontSize: 13, color: C.gray, marginBottom: 16 }}>Full visibility — users, jobs, bids, deposit revenue, and flagged messages.</p>

      {/* Payment model banner — shows the active model + where to flip it */}
      <div style={{
        background: C.tealLight, border: `1px solid ${C.teal}44`, borderRadius: 10,
        padding: "12px 14px", marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start",
      }}>
        <span style={{ fontSize: 18 }}>💳</span>
        <div style={{ fontSize: 12.5, color: C.pineDeep, lineHeight: 1.55 }}>
          <strong>Active payment model: {DEFAULT_PAYMENT_MODE === "full" ? "Full payment (escrow)" : "Deposit-only (launch model)"}</strong>
          <div style={{ color: C.gray, marginTop: 3 }}>
            {DEFAULT_PAYMENT_MODE === "full"
              ? "Customers pay the full amount through MyTrashBid; the 90% balance is held and released to the hauler on completion."
              : "Customers prepay a 10% deposit (our revenue); the 90% balance is paid hauler-direct, off-platform. Each job also carries its own paymentMode, so full-payment can be switched on globally or offered per-job later — no rebuild required."}
          </div>
        </div>
      </div>

      {/* Stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 24 }}>
        <Stat label="Customers" value={customers.length} />
        <Stat label="Haulers" value={haulers.length} />
        <Stat label="Total jobs" value={jobs.length} />
        <Stat label="Booked jobs" value={bookedJobs.length} />
        <Stat label="GMV (booked)" value={`$${totalGMV.toFixed(2)}`} mono />
        <Stat label="Deposit revenue (10%)" value={`$${depositCollected.toFixed(2)}`} mono accent />
        <Stat label="Paid hauler-direct (90%)" value={`$${haulerDirectVolume.toFixed(2)}`} mono />
        <Stat label="Overdue completions" value={overdueJobs.length} accent={overdueJobs.length > 0} />
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {[
          { id: "overview", label: "Overview" },
          { id: "users", label: `Users (${users.length})` },
          { id: "jobs", label: `Jobs & bids (${jobs.length})` },
          { id: "flags", label: `Flagged messages (${flags.length})` },
          { id: "overdue", label: `Overdue completions (${overdueJobs.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: tab === t.id ? C.pine : C.paper, color: tab === t.id ? C.paper : C.ink,
            border: `1px solid ${tab === t.id ? C.pine : C.line}`, borderRadius: 8, padding: "8px 14px",
            fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: sans,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "overview" && (
        <div style={{ display: "grid", gap: 16 }}>
          <Panel title="Recent jobs">
            {jobs.slice(0, 5).map(j => <JobRow key={j.id} job={j} />)}
            {jobs.length === 0 && <CenteredNote>No jobs yet.</CenteredNote>}
          </Panel>
          {overdueJobs.length > 0 && (
            <Panel title={`⚠ Overdue completions (${overdueJobs.length})`}>
              {overdueJobs.map(j => <OverdueJobRow key={j.id} job={j} />)}
            </Panel>
          )}
          <Panel title="Recent flags">
            {flags.slice(-5).reverse().map(f => <FlagRow key={f.id} flag={f} />)}
            {flags.length === 0 && <CenteredNote>No flagged messages yet.</CenteredNote>}
          </Panel>
        </div>
      )}

      {tab === "users" && (
        <Panel title="All accounts">
          <div style={{ display: "grid", gap: 8 }}>
            {users.length === 0 && <CenteredNote>No accounts yet.</CenteredNote>}
            {users.map(u => (
              <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: `1px solid ${C.line}`, borderRadius: 10 }}>
                <Avatar emoji={u.role === "customer" ? "👤" : "🚛"} size={32} bg={u.role === "customer" ? C.sandWarm : C.tealLight} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{u.role === "customer" ? u.name : u.businessName}</div>
                  <div style={{ fontSize: 11.5, color: C.gray }}>{u.email} · ZIP {u.zip} · joined {u.createdAt}</div>
                </div>
                <Badge color={u.role === "customer" ? C.gray : C.teal} bg={u.role === "customer" ? C.grayLight : C.tealLight}>{u.role}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {tab === "jobs" && (
        <Panel title="All jobs & bids">
          <div style={{ display: "grid", gap: 10 }}>
            {jobs.length === 0 && <CenteredNote>No jobs yet.</CenteredNote>}
            {jobs.map(j => <JobRowExpanded key={j.id} job={j} />)}
          </div>
        </Panel>
      )}

      {tab === "flags" && (
        <Panel title="Flagged messages (Trust & Safety queue)">
          <div style={{ display: "grid", gap: 8 }}>
            {flags.length === 0 && <CenteredNote>No flagged messages yet.</CenteredNote>}
            {flags.slice().reverse().map(f => <FlagRow key={f.id} flag={f} expanded />)}
          </div>
        </Panel>
      )}

      {tab === "overdue" && (
        <Panel title="Jobs past the 30-day completion window">
          <div style={{ display: "grid", gap: 8 }}>
            {overdueJobs.length === 0 && <CenteredNote>Nothing overdue right now.</CenteredNote>}
            {overdueJobs.map(j => <OverdueJobRow key={j.id} job={j} expanded />)}
          </div>
        </Panel>
      )}
    </div>
  );
}

function Stat({ label, value, mono: isMono, accent }) {
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 14px" }}>
      <div style={{ fontSize: 10.5, color: C.gray, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: isMono ? mono : sans, fontSize: 19, fontWeight: 800, color: accent ? C.ember : C.pineDeep }}>{value}</div>
    </div>
  );
}
function Panel({ title, children }) {
  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.03em" }}>{title}</div>
      {children}
    </div>
  );
}
function JobRow({ job }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
      <span style={{ color: C.ink, fontWeight: 600 }}>{job.title}</span>
      <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
    </div>
  );
}
function JobRowExpanded({ job }) {
  const [open, setOpen] = useState(false);
  const jobExpired = job.status === "open" && isExpired(job.expiresAtMs);
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", background: "none", border: "none", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontFamily: sans }}>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: C.pineDeep }}>{job.title}</div>
          <div style={{ fontSize: 11, color: C.gray }}>by {job.customerName} · ZIP {job.zip} · {(job.bids || []).length} bids</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {job.status === "open" && <Badge color={jobExpired ? C.red : C.gray} bg={jobExpired ? C.redLight : C.grayLight}>{expiryLabel(job.expiresAtMs)}</Badge>}
          <Badge color={job.status === "booked" ? C.teal : C.ember} bg={job.status === "booked" ? C.tealLight : C.emberLight}>{job.status}</Badge>
        </div>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 14px" }}>
          {(job.bids || []).length === 0 && <div style={{ fontSize: 12, color: C.gray }}>No bids yet.</div>}
          {(job.bids || []).map(b => (
            <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
              <span>{b.businessName} {b.id === job.acceptedBidId && <Badge color={C.teal} bg={C.tealLight}>Won</Badge>} {job.status === "open" && <Badge color={isExpired(b.expiresAtMs) ? C.red : C.gray} bg={isExpired(b.expiresAtMs) ? C.redLight : C.grayLight}>{expiryLabel(b.expiresAtMs)}</Badge>}</span>
              <span style={{ fontFamily: mono, fontWeight: 700 }}>${b.amount} <span style={{ color: C.gray, fontWeight: 400 }}>(${(b.amount * 0.1).toFixed(2)} deposit)</span></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function FlagRow({ flag, expanded }) {
  const isRepeat = flag.severity === "warned-repeat";
  return (
    <div style={{ border: `1px solid ${isRepeat ? C.red : C.amber}55`, background: isRepeat ? C.redLight : C.amberLight, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: isRepeat ? C.red : "#8A6604" }}>
          {isRepeat ? "🚩 Repeat offense" : "🛡️ First flag"} — {flag.senderName} ({flag.sender})
        </span>
        <span style={{ fontSize: 10.5, color: C.gray }}>{flag.time}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray, marginBottom: 4 }}>Job: {flag.jobTitle}</div>
      {expanded && <div style={{ fontSize: 13, color: C.ink, background: C.paper, borderRadius: 8, padding: "8px 10px" }}>"{flag.text}"</div>}
    </div>
  );
}

function OverdueJobRow({ job, expanded }) {
  const bid = (job.bids || []).find(b => b.id === job.acceptedBidId);
  const daysSince = job.completeByMs ? Math.floor((Date.now() - (job.completeByMs - COMPLETION_WINDOW_MS)) / (24 * 60 * 60 * 1000)) : null;
  return (
    <div style={{ border: `1px solid ${C.red}55`, background: C.redLight, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.red }}>⚠ {job.title}</span>
        <span style={{ fontSize: 10.5, color: C.gray }}>{daysSince} days since booked</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.gray }}>
        Customer: {job.customerName} · Hauler: {bid?.businessName || "—"} · Bid: ${bid?.amount}
      </div>
      {expanded && (
        <div style={{ fontSize: 11.5, color: "#8B3A30", marginTop: 6, lineHeight: 1.5 }}>
          Hauler has not confirmed completion past the 30-day window. They've received an in-app reminder. The ${bid ? (bid.amount * 0.1).toFixed(2) : "—"} deposit was already collected at booking; confirmation just closes out the job and unlocks reviews. Consider reaching out directly.
        </div>
      )}
    </div>
  );
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
function Toast({ message, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: C.pineDeep, color: C.paper, borderRadius: 10, padding: "12px 18px", fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", maxWidth: "90%", textAlign: "center" }}>
      {message}
    </div>
  );
}

// ─── App root ─────────────────────────────────────────────────────────────────
export default function App() {
  const [stage, setStage] = useState("landing"); // landing | auth | app
  const [authRole, setAuthRole] = useState(null);
  const [session, setSession] = useState(null);
  const [page, setPage] = useState("jobs");
  const [activeChatId, setActiveChatId] = useState(null);
  const [toast, setToast] = useState(null);

  function pickRole(role) {
    setAuthRole(role);
    setStage("auth");
  }
  function handleAuthed(user) {
    setSession(user);
    setPage(user.role === "admin" ? "admin" : "jobs");
    setStage("app");
  }
  function logout() {
    setSession(null);
    setActiveChatId(null);
    setStage("landing");
  }

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@700;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; font-family: 'Inter', system-ui, sans-serif; background: ${C.sand}; }
        textarea:focus, input:focus { border-color: ${C.teal} !important; }
      `}</style>

      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      {stage === "landing" && <AuthLanding onPick={pickRole} />}
      {stage === "auth" && <AuthForm role={authRole} onBack={() => setStage("landing")} onAuthed={handleAuthed} setToast={setToast} />}

      {stage === "app" && session && (
        <div style={{ minHeight: "100vh", background: C.sand }}>
          <TopBar session={session} onLogout={logout} onNav={(p) => { setPage(p); setActiveChatId(null); }} page={page} />
          {session.role === "admin" && page === "admin" && <AdminDashboard />}
          {session.role !== "admin" && page === "jobs" && (
            <JobsPage session={session} setToast={setToast} onOpenChat={(id) => { setActiveChatId(id); setPage("chats"); }} />
          )}
          {session.role !== "admin" && page === "chats" && !activeChatId && (
            <ChatsListPage session={session} onOpenChat={setActiveChatId} />
          )}
          {session.role !== "admin" && page === "chats" && activeChatId && (
            <ChatThread chatId={activeChatId} session={session} onClose={() => setActiveChatId(null)} setToast={setToast} />
          )}
        </div>
      )}
    </>
  );
}
