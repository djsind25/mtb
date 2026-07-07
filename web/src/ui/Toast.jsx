import { useEffect } from "react";
import { C } from "../theme";

export function Toast({ message, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 4000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 999, background: C.pineDeep, color: C.paper, borderRadius: 10, padding: "12px 18px", fontSize: 13, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", maxWidth: "90%", textAlign: "center" }}>
      {message}
    </div>
  );
}
