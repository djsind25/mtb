import { useState } from "react";
import { C, nowStr, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Btn } from "../ui/Primitives";
import { approveProfileChangeRequest, denyProfileChangeRequest } from "./data";

const FIELD_LABELS = {
  business_name: "Business name",
  license_number: "License number",
  insurance_info: "Insurance info",
  business_registration_number: "Business registration number",
};

const STATUS_STYLE = {
  pending: { color: C.amber, bg: C.amberLight },
  approved: { color: C.teal, bg: C.tealLight },
  denied: { color: C.red, bg: C.redLight },
};

export function ProfileChangeRequestRow({ request, onChanged, setToast, readOnly }) {
  const [confirming, setConfirming] = useState(null); // "approve" | "deny" | null
  const [working, setWorking] = useState(false);
  const status = STATUS_STYLE[request.status] || STATUS_STYLE.pending;

  async function resolve(approve) {
    setWorking(true);
    try {
      if (approve) await approveProfileChangeRequest(request.id, null);
      else await denyProfileChangeRequest(request.id, null);
      setToast(`Change request ${approve ? "approved" : "denied"}.`);
      onChanged();
    } catch (e) {
      setToast(e.message || "Could not resolve this request.");
    }
    setWorking(false);
    setConfirming(null);
  }

  return (
    <div style={{
      border: `1px solid ${request.status === "pending" ? C.amber + "66" : C.line}`,
      background: request.status === "pending" ? C.amberLight : C.paper,
      borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: "10px 12px", display: "grid", gap: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: C.pineDeep }}>
          {request.haulerName || "Unknown hauler"} · {FIELD_LABELS[request.field] || request.field}
        </span>
        <Badge color={status.color} bg={status.bg}>{request.status}</Badge>
      </div>
      <div style={{ fontSize: 12.5, color: C.ink }}>
        <span style={{ color: C.gray }}>{request.old_value || "—"}</span> → <strong>{request.requested_value}</strong>
      </div>
      {request.reason && <div style={{ fontSize: 11.5, color: C.gray }}>Reason: {request.reason}</div>}
      <div style={{ fontSize: 10.5, color: C.gray }}>Requested {nowStr(request.created_at)}</div>

      {request.status === "pending" && !readOnly && (
        confirming ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11.5, color: C.gray }}>
              {confirming === "approve" ? "Approve this change?" : "Deny this change?"}
            </span>
            <Btn size="sm" full={false} variant={confirming === "approve" ? "teal" : "danger"} disabled={working}
              onClick={() => resolve(confirming === "approve")}>Yes</Btn>
            <Btn size="sm" full={false} variant="ghost" onClick={() => setConfirming(null)}>No</Btn>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" full={false} variant="danger" disabled={working} onClick={() => setConfirming("deny")}>Deny</Btn>
            <Btn size="sm" full={false} variant="teal" disabled={working} onClick={() => setConfirming("approve")}>Approve</Btn>
          </div>
        )
      )}
    </div>
  );
}
