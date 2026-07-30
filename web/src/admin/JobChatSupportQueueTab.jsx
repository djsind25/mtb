import { useEffect, useState } from "react";
import { C, sans, nowStr, RADIUS, SHADOW_SM } from "../theme";
import { Badge, Field, CenteredNote } from "../ui/Primitives";
import { AdminChatViewer } from "./AdminChatViewer";
import { supabase } from "../lib/supabaseClient";

const STATUS_META = {
  requested: { label: "🆘 Requested", color: C.amber, bg: C.amberLight },
  active: { label: "🛡️ Active", color: C.slate, bg: C.slateLight },
  resolved: { label: "✓ Resolved", color: C.gray, bg: C.grayLight },
};

function Row({ chat, onOpen }) {
  const meta = STATUS_META[chat.support_status];
  return (
    <button onClick={() => onOpen(chat.id)} style={{
      width: "100%", background: C.paper, border: `1px solid ${chat.support_status === "requested" ? C.amber + "66" : C.line}`,
      borderRadius: RADIUS.md, boxShadow: SHADOW_SM, padding: 14, cursor: "pointer", textAlign: "left", fontFamily: "inherit",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.pineDeep }}>{chat.jobTitle || "Job"}</div>
          <div style={{ fontSize: 11.5, color: C.gray, marginTop: 2 }}>
            {chat.customerName} ↔ {chat.haulerName} · ZIP {chat.zip || "—"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {meta && <Badge color={meta.color} bg={meta.bg}>{meta.label}</Badge>}
          {chat.admin_locked_at && <Badge color={C.red} bg={C.redLight}>🔒 Locked</Badge>}
        </div>
      </div>
      {chat.latestRequest?.reason && (
        <div style={{ fontSize: 12, color: C.ink, fontStyle: "italic", marginBottom: 4 }}>"{chat.latestRequest.reason}"</div>
      )}
      <div style={{ fontSize: 10.5, color: C.gray, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{nowStr(chat.latestRequest?.created_at || chat.created_at)}</span>
        {chat.assignedAdminName && <span style={{ fontFamily: sans }}>Handling: {chat.assignedAdminName}</span>}
      </div>
    </button>
  );
}

// The support-facing counterpart to "Open chat tickets" (the unrelated, general
// Contact-Administrator system) — this queue is specifically about job chats where a customer or
// hauler asked for help, or an admin is already participating. Filtering/search is all
// client-side against the already-loaded queue array, same idiom as AdminDashboard's own
// flags/overdue lists.
export function JobChatSupportQueueTab({ queue, onChanged, setToast, readOnly, session }) {
  const [statusFilter, setStatusFilter] = useState("open"); // "open" | "resolved" | "all"
  const [search, setSearch] = useState("");
  const [assignedFilter, setAssignedFilter] = useState("all");
  const [openChatId, setOpenChatId] = useState(null);

  // Keeps the queue list itself live while a chat's modal is open (support_status/admin_locked_at
  // changes land on chats; new/resolved/reopened requests land on support_requests) — one channel
  // per table, matching this app's "two postgres_changes bindings on one channel silently break
  // both" constraint. The modal's own state is already kept fresh by its own reload(); this only
  // refreshes the outer row list.
  useEffect(() => {
    const chatsChannel = supabase
      .channel("admin-support-queue-chats")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chats" }, () => onChanged())
      .subscribe();
    const requestsChannel = supabase
      .channel("admin-support-queue-requests")
      .on("postgres_changes", { event: "*", schema: "public", table: "support_requests" }, () => onChanged())
      .subscribe();
    return () => { supabase.removeChannel(chatsChannel); supabase.removeChannel(requestsChannel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const assignedAdmins = [...new Map(
    queue.filter(c => c.assignedAdminName).map(c => [c.assigned_admin_id, c.assignedAdminName])
  ).entries()];

  const q = search.trim().toLowerCase();
  const visible = queue
    .filter(c => statusFilter === "open" ? c.support_status !== "resolved" : statusFilter === "resolved" ? c.support_status === "resolved" : true)
    .filter(c => assignedFilter === "all" || c.assigned_admin_id === assignedFilter)
    .filter(c => !q || [c.jobTitle, c.customerName, c.haulerName, c.zip].some(f => (f || "").toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.latestRequest?.created_at || b.created_at) - new Date(a.latestRequest?.created_at || a.created_at));

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {[
          { id: "open", label: "Open" },
          { id: "resolved", label: "Resolved" },
          { id: "all", label: "All" },
        ].map(s => (
          <button key={s.id} onClick={() => setStatusFilter(s.id)} style={{
            background: statusFilter === s.id ? C.pine : C.paper, color: statusFilter === s.id ? C.paper : C.ink,
            border: `1px solid ${statusFilter === s.id ? C.pine : C.line}`, borderRadius: RADIUS.sm, padding: "6px 12px",
            fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
          }}>{s.label}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180 }}><Field value={search} onChange={setSearch} placeholder="Search by job, customer, or hauler…" /></div>
        {assignedAdmins.length > 0 && (
          <select value={assignedFilter} onChange={e => setAssignedFilter(e.target.value)} style={{
            border: `1px solid ${C.line}`, borderRadius: RADIUS.sm, padding: "9px 10px", fontSize: 12.5,
            fontFamily: "inherit", color: C.ink, background: C.paper,
          }}>
            <option value="all">Any assigned admin</option>
            {assignedAdmins.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {queue.length === 0 && <CenteredNote>No job chats have needed support yet.</CenteredNote>}
        {queue.length > 0 && visible.length === 0 && <CenteredNote>Nothing matches this filter.</CenteredNote>}
        {visible.map(c => <Row key={c.id} chat={c} onOpen={setOpenChatId} />)}
      </div>

      {openChatId && (
        <AdminChatViewer
          chatId={openChatId}
          viewerId={session.id}
          readOnly={readOnly}
          setToast={setToast}
          onClose={() => { setOpenChatId(null); onChanged(); }}
        />
      )}
    </div>
  );
}
