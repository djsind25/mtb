import { C, mono, expiryLabel, isExpired, daysLeft } from "../theme";
import { Badge, Btn } from "../ui/Primitives";

export function HaulerBidStatusCard({ job, session, onOpenChat, onRenewBid, onConfirmComplete }) {
  const myBid = job.myBid;
  const won = job.status === "booked" && job.accepted_bid_id === myBid?.id;
  const lost = job.status === "booked" && job.accepted_bid_id !== myBid?.id;
  const pending = (!job.status || job.status === "open");
  const bidExpired = pending && isExpired(myBid?.expires_at);

  const completionOverdue = won && !job.completed && isExpired(job.complete_by);
  const completionDaysLeft = won && !job.completed ? daysLeft(job.complete_by) : null;

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
        {pending && <Badge color={C.gray} bg={C.grayLight}>{expiryLabel(myBid?.expires_at)}</Badge>}
        {won && !job.completed && !completionOverdue && <Badge color={C.gray} bg={C.grayLight}>Confirm within {completionDaysLeft} day{completionDaysLeft !== 1 ? "s" : ""}</Badge>}
        {completionOverdue && <Badge color={C.red} bg={C.redLight}>⚠ 30-day window passed — please confirm</Badge>}
      </div>

      {bidExpired && (
        <Btn size="sm" variant="dark" onClick={() => onRenewBid(myBid.id)}>Renew bid — 14 more days</Btn>
      )}

      {won && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <Btn size="sm" variant="teal" full={false} onClick={() => onOpenChat(job.chatId)}>Open chat</Btn>
          {!job.completed && (
            <Btn size="sm" full={false} variant={completionOverdue ? "danger" : "primary"} onClick={() => onConfirmComplete(job.id)}>
              ✓ Confirm job complete
            </Btn>
          )}
        </div>
      )}
      {completionOverdue && (
        <div style={{ fontSize: 11, color: "#8A6604", background: C.amberLight, borderRadius: 8, padding: "8px 10px", marginTop: 8, lineHeight: 1.5 }}>
          🔔 Reminder: it's been over 30 days since this job was booked. Please confirm completion so the customer can leave a review and your commission can finalize.
        </div>
      )}
    </div>
  );
}
