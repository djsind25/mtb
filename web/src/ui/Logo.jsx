import { C, sans } from "../theme";

export function LogoMark({ size = 26 }) {
  const pad = Math.round(size * 0.18);
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
    }}>
      <img src="/logo.png" width={size - pad * 2} height={size - pad * 2} alt="" style={{ objectFit: "contain" }} />
    </div>
  );
}

export function Wordmark({ size = 17 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <LogoMark size={size + 9} />
      <span style={{ fontFamily: sans, fontWeight: 800, fontSize: size, letterSpacing: "-0.02em" }}>
        <span style={{ color: C.charcoal }}>MyTrash</span><span style={{ color: C.green }}>Bid</span>
      </span>
    </div>
  );
}
