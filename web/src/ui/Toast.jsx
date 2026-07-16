import { useEffect } from "react";
import { C, SHADOW_MD } from "../theme";

export function Toast({ message, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: C.pineDeep, color: C.paper, borderRadius: 16, padding: "12px 18px", fontSize: 13, boxShadow: SHADOW_MD, maxWidth: "90%", textAlign: "center" }}>
      {message}
    </div>
  );
}
