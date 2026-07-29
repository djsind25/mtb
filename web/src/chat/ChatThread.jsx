import { useEffect, useRef, useState } from "react";
import { C, sans, RADIUS, SHADOW_SM } from "../theme";
import { supabase } from "../lib/supabaseClient";
import { Avatar, Badge, CenteredNote } from "../ui/Primitives";
import { loadChat, loadMessages, sendMessage, markChatRead } from "./data";
import { addJobPhotos, loadPendingSchedule, loadScheduleHistory } from "../jobs/data";
import { JobStatusPanel } from "./JobStatusPanel";
import { ChatBubble } from "./ChatBubble";
import { ReviewPanel } from "./ReviewPanel";

export function ChatThread({ chatId, session, onClose, setToast }) {
  const [chat, setChat] = useState(null);
  const [messages, setMessages] = useState([]);
  const [pendingSchedule, setPendingSchedule] = useState(null);
  const [scheduleHistory, setScheduleHistory] = useState([]);
  const [draft, setDraft] = useState("");
  const [bannerExpanded, setBannerExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const scrollRef = useRef(null);
  const photoInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadChat(chatId), loadMessages(chatId)]).then(([c, m]) => {
      if (cancelled) return;
      setChat(c);
      setMessages(m);
    });
    markChatRead(chatId, session.role).catch(() => {});
    return () => { cancelled = true; };
  }, [chatId, session.role]);

  // schedule_proposals has no Realtime subscription of its own here — propose_schedule() and
  // confirm_schedule() both insert a system chat message, so refetching whenever a new message
  // arrives (or the chat first loads) keeps this fresh via infrastructure that already exists,
  // same "best-effort freshness" reasoning as sync_full_payment_schedule().
  function refreshSchedule() {
    if (!chat?.job_id) return;
    Promise.all([loadPendingSchedule(chat.job_id), loadScheduleHistory(chatId)])
      .then(([p, h]) => { setPendingSchedule(p); setScheduleHistory(h); })
      .catch(() => {});
  }
  useEffect(refreshSchedule, [chat?.job_id, chatId, messages.length]);

  // Two postgres_changes bindings on a single channel silently breaks delivery of both in
  // this Realtime version (confirmed empirically) — one channel per table subscribed.
  useEffect(() => {
    const messagesChannel = supabase
      .channel(`chat-messages-${chatId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
        (payload) => setMessages(prev => prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new]))
      .subscribe();
    const chatChannel = supabase
      .channel(`chat-updates-${chatId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chats", filter: `id=eq.${chatId}` },
        (payload) => setChat(prev => ({ ...prev, ...payload.new })))
      .subscribe();
    return () => { supabase.removeChannel(messagesChannel); supabase.removeChannel(chatChannel); };
  }, [chatId]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages.length]);

  if (!chat) return <CenteredNote>Loading chat…</CenteredNote>;

  const viewer = session.role; // "customer" | "hauler"

  async function send() {
    if (!draft.trim()) return;
    setSending(true);
    try {
      await sendMessage({ chatId, senderRole: viewer, senderId: session.id, text: draft.trim() });
      setDraft("");
    } catch (e) {
      setToast(e.message || "Could not send message.");
    }
    setSending(false);
  }

  // For when the hauler asks to see more of the item before finalizing — the customer adds
  // photos right from the conversation instead of navigating back to the job post. They land in
  // the same Job Photos album postJob() created (addJobPhotos), and a normal chat message (not a
  // spoofable "system" one — see note below) tells the hauler where to find them, which also
  // gets them the exact same email/SMS notification any other new message would.
  async function handleAddPhotos(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith("image/") || /\.hei[cf]$/i.test(f.name));
    if (files.length === 0) return;
    setAddingPhotos(true);
    try {
      const uploaded = await addJobPhotos({ jobId: chat.job_id, files });
      const note = uploaded.length === 1
        ? "📷 Added 1 new photo to this job's Photo Album."
        : `📷 Added ${uploaded.length} new photos to this job's Photo Album.`;
      await sendMessage({ chatId, senderRole: viewer, senderId: session.id, text: note });
    } catch (e) {
      setToast(e.message || "Could not add photos.");
    }
    setAddingPhotos(false);
  }

  const otherName = viewer === "customer" ? chat.businessName : chat.customerName;
  const otherIsBiz = viewer === "customer";
  const isFull = chat.payment_mode === "full";
  const deposit = chat.deposit;
  const balanceDue = chat.balance_due;
  // Jobs accepted after the scheduling rework (20260803000000) carry coordination_deadline from
  // the moment they're booked — a full-mode job with none of these set predates that migration
  // and was charged in full at accept under the old flow, so its display stays exactly as before.
  const hasScheduling = isFull && !!(chat.coordination_deadline || chat.coordination_extended_at || chat.stalled_at || chat.locked_service_date);
  const effectiveAmount = Number(chat.locked_final_price ?? chat.bid_amount);
  const haulerCut = isFull ? effectiveAmount * 0.9 : chat.bid_amount - chat.commission;
  const moneyState = !hasScheduling ? "legacyHeld"
    : chat.captured_at ? "captured"
    : chat.authorized_at ? "authorized"
    : chat.locked_service_date ? "scheduled"
    : "coordinating";

  return (
    <div style={{ maxWidth: 880, margin: "0 auto", padding: "16px 16px 0" }}>
      <style>{`
        .mtb-chat-grid { display: grid; grid-template-columns: 1fr 320px; gap: 20px; align-items: start; }
        .mtb-chat-sidebar { position: sticky; top: 16px; }
        @media (max-width: 860px) {
          .mtb-chat-grid { grid-template-columns: 1fr; }
          .mtb-chat-sidebar { position: static; order: 2; }
          .mtb-chat-main { order: 1; }
        }
      `}</style>

      <button onClick={onClose} style={{ background: "none", border: "none", color: C.gray, fontSize: 13, cursor: "pointer", marginBottom: 10, textAlign: "left" }}>← Back to chats</button>

      <div className="mtb-chat-grid">
        <div className="mtb-chat-main" style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: RADIUS.lg, boxShadow: SHADOW_SM, display: "flex", flexDirection: "column", height: "calc(100vh - 96px)", overflow: "hidden" }}>
          <div style={{ background: C.paper, borderBottom: `1px solid ${C.line}`, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar emoji={otherIsBiz ? "🚛" : "👤"} bg={otherIsBiz ? C.tealLight : C.sandWarm} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.pineDeep }}>{otherName}</div>
              <div style={{ fontSize: 11, color: C.gray }}>{chat.jobTitle}</div>
            </div>
            <Badge color={C.slate} bg={C.slateLight}>🛡️ Monitored</Badge>
          </div>

          {/* Consolidated trust-and-safety notice — one collapsible surface instead of the old
              separate amber "monitored" banner plus a second teal "stay on-platform" banner (that
              second banner's content now lives as a short reminder in JobStatusPanel instead). */}
          <div style={{ background: C.slateLight, borderBottom: `1px solid ${C.line}`, padding: bannerExpanded ? "12px 16px" : "9px 16px" }}>
            <button onClick={() => setBannerExpanded(e => !e)} style={{ width: "100%", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: 0, fontFamily: sans, textAlign: "left" }}>
              <span>🛡️</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: C.slate, flex: 1 }}>This chat is monitored to keep the platform fair</span>
              <span style={{ fontSize: 11, color: C.slate }}>{bannerExpanded ? "▲" : "▼"}</span>
            </button>
            {bannerExpanded && (
              <div style={{ fontSize: 12, color: C.slate, lineHeight: 1.55, marginTop: 8, paddingLeft: 22 }}>
                <div style={{ marginBottom: 8 }}>Messages here are screened in real time, and phone numbers and email addresses are automatically hidden if shared.</div>
                {chat?.payment_mode === "full" ? (
                  moneyState === "coordinating" || moneyState === "scheduled" ? (
                    <>Nothing is charged until 48 hours before your scheduled service date — then it's held securely and released once the job is confirmed complete. There's nothing to pay directly. What we do flag is sharing contact info to arrange jobs <em>outside</em> MyTrashBid to skip that protection. First mentions send with a warning; repeated attempts are flagged for Trust &amp; Safety review.</>
                  ) : (
                    <>Your payment is held securely and released once the job is confirmed complete — there's nothing to pay directly. What we do flag is sharing contact info to arrange jobs <em>outside</em> MyTrashBid to skip that protection. First mentions send with a warning; repeated attempts are flagged for Trust &amp; Safety review.</>
                  )
                ) : (
                  <>Paying your hauler the remaining balance directly is expected and fine. What we do flag is sharing contact info to arrange jobs <em>outside</em> MyTrashBid to skip the deposit that keeps this service running. First mentions send with a warning; repeated attempts are flagged for Trust &amp; Safety review.</>
                )}
              </div>
            )}
          </div>

          {chat.reviews_unlocked && (
            <ReviewPanel chat={chat} chatId={chatId} viewer={viewer} setToast={setToast} />
          )}

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "10px 0" }}>
            {messages.map(m => <ChatBubble key={m.id} msg={m} viewer={viewer} />)}
          </div>

          <div style={{ borderTop: `1px solid ${C.line}`, padding: "10px 12px" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              {viewer === "customer" && (
                <>
                  <input ref={photoInputRef} type="file" accept="image/*,.heic,.heif" multiple style={{ display: "none" }}
                    onChange={e => { handleAddPhotos(e.target.files); e.target.value = ""; }} />
                  <button onClick={() => photoInputRef.current?.click()} disabled={addingPhotos} title="Add photos to this job"
                    aria-label="Add photos to this job" style={{
                      position: "relative", width: 36, height: 36, borderRadius: "50%", flexShrink: 0, border: `1.5px solid ${C.line}`,
                      cursor: addingPhotos ? "default" : "pointer", background: C.paper,
                      color: C.gray, fontSize: 15, opacity: addingPhotos ? 0.6 : 1,
                    }}>
                      {addingPhotos ? "…" : (
                        <>
                          📷
                          <span style={{
                            position: "absolute", top: -3, right: -3, width: 15, height: 15, borderRadius: "50%",
                            background: C.ember, color: C.paper, fontSize: 11, fontWeight: 700, lineHeight: "15px",
                            textAlign: "center", border: `1.5px solid ${C.paper}`,
                          }}>+</span>
                        </>
                      )}
                    </button>
                </>
              )}
              <textarea value={draft} onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Message about this job…" rows={1}
                style={{ flex: 1, resize: "none", border: `1.5px solid ${C.line}`, borderRadius: 20, padding: "9px 15px", fontSize: 13.5, fontFamily: "inherit", outline: "none", color: C.ink, background: C.sand }} />
              <button onClick={send} disabled={!draft.trim() || sending} style={{
                width: 36, height: 36, borderRadius: "50%", flexShrink: 0, border: "none",
                cursor: draft.trim() ? "pointer" : "default", background: draft.trim() ? C.ember : C.grayLight,
                color: C.paper, fontSize: 14,
              }}>➤</button>
            </div>
          </div>
        </div>

        <div className="mtb-chat-sidebar">
          <JobStatusPanel
            chat={chat}
            pendingSchedule={pendingSchedule}
            scheduleHistory={scheduleHistory}
            viewer={viewer}
            viewerId={session.id}
            effectiveAmount={effectiveAmount}
            haulerCut={haulerCut}
            moneyState={moneyState}
            isFull={isFull}
            deposit={deposit}
            balanceDue={balanceDue}
            onScheduleChanged={refreshSchedule}
            setToast={setToast}
          />
        </div>
      </div>
    </div>
  );
}
