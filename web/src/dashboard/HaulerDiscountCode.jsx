import { useEffect, useState } from "react";
import { C } from "../theme";
import { Btn, Field, Badge } from "../ui/Primitives";
import { redeemHaulerDiscountCode, loadMyPendingDiscount, loadMyDiscountHistory } from "./data";

const sectionTitle = { fontSize: 15, fontWeight: 700, color: C.pineDeep, marginBottom: 12 };

export function HaulerDiscountCode({ setToast }) {
  const [pending, setPending] = useState(undefined); // undefined = loading, null = none
  const [history, setHistory] = useState([]);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  async function refresh() {
    const [p, h] = await Promise.all([loadMyPendingDiscount(), loadMyDiscountHistory()]);
    setPending(p);
    setHistory(h);
  }

  useEffect(() => { refresh(); }, []);

  async function redeem() {
    if (!code.trim()) return;
    setRedeeming(true);
    try {
      await redeemHaulerDiscountCode(code.trim());
      setCode("");
      setToast("Discount code applied — you'll pay a reduced platform fee on your next completed job.");
      await refresh();
    } catch (e) {
      setToast(e.message || "That code didn't work.");
    }
    setRedeeming(false);
  }

  if (pending === undefined) return null;

  return (
    <section>
      <div style={sectionTitle}>Discount code</div>
      {pending ? (
        <div style={{ background: C.tealLight, border: `1px solid ${C.teal}55`, borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep, marginBottom: 2 }}>
            Discount ready: platform fee reduced by {Number(pending.discountValue)} points on your next completed job
          </div>
          <div style={{ fontSize: 11.5, color: C.gray }}>
            Code <strong>{pending.code}</strong>{pending.appliedChatId
              ? " is already reserved to a job you just won — it'll be used once that job is confirmed complete."
              : " is ready to apply to your next accepted bid."}
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 12.5, color: C.gray, marginBottom: 10 }}>
            Have a discount code? It reduces the platform fee on your next completed job — the
            customer's price is never affected, you just keep more of your payout.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 4 }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="Have a discount code?" value={code} onChange={setCode} placeholder="CODE" />
            </div>
            <Btn full={false} onClick={redeem} disabled={redeeming || !code.trim()}>{redeeming ? "Applying…" : "Apply code"}</Btn>
          </div>
        </>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setShowHistory(s => !s)} style={{
            background: "none", border: "none", padding: 0, color: C.teal, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
          }}>
            Discount history {showHistory ? "▲" : "▼"}
          </button>
          {showHistory && (
            <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              {history.map(h => (
                <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.paper, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 12, color: C.ink }}>{h.jobTitle || "Job"}</div>
                  <Badge color={C.teal} bg={C.tealLight}>Saved ${Number(h.amountSaved).toFixed(2)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
