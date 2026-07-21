"use client";

// Messages — left rail with chat list (groups + DMs), right pane with
// the active thread + input. Replies sent here fan out to teammates'
// WhatsApp. Replies coming in via WhatsApp (with reply context) get
// stitched back into the same thread by the bot.
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/dash-page";

type TeamRef = { name: string; member_count: number; is_admin: boolean; admin_phone: string };

type Chat = {
  id: number; team_admin_phone: string; team_name: string | null;
  type: "group" | "dm"; name: string | null;
  created_by: string; created_at: string;
  last_message_at: string | null;
  member_count: number;
  unread_count: number;
  // DM-only: the other party, server-computed.
  partner_phone?: string | null;
  partner_name?: string | null;
};

type ChatMember = { chat_id: number; member_phone: string; member_name: string | null; joined_at: string };

type ChatMessage = {
  id: number; chat_id: number;
  from_phone: string; from_name: string | null;
  text: string; sent_via: "dashboard" | "whatsapp" | "system";
  wamid: string | null; reply_to_wamid: string | null;
  created_at: string;
};

type Member = { member_phone: string; member_name: string | null };

export function MessagesContent({
  currentUserPhone,
  teamName,
}: {
  currentUserPhone: string;
  teamName?: string;
}) {
  const [teams, setTeams] = useState<TeamRef[] | null>(null);
  const [selectedTeam, setSelectedTeam] = useState<string | null>(teamName || null);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [activeChat, setActiveChat] = useState<{ chat: Chat; members: ChatMember[]; messages: ChatMessage[] } | null>(null);
  const [teamMembers, setTeamMembers] = useState<Member[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  // Bootstrap: pick the user's team
  useEffect(() => {
    let cancelled = false;
    fetch("/api/team/list", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; teams?: TeamRef[]; error?: string }) => {
        if (cancelled) return;
        if (!d.ok) { setError(d.error || "Could not load teams."); setTeams([]); return; }
        setTeams(d.teams || []);
        if (teamName) {
          const requested = (d.teams || []).find(team => team.name.toLowerCase() === teamName.toLowerCase());
          setSelectedTeam(requested?.name || null);
        } else if (d.teams && d.teams.length > 0) {
          // Prefer admin teams, then first
          const owned = d.teams.find(t => t.is_admin);
          setSelectedTeam(owned?.name || d.teams[0].name);
        }
      })
      .catch(e => { if (!cancelled) { setError(String(e)); setTeams([]); } });
    return () => { cancelled = true; };
  }, [teamName]);

  // Load chats list when team changes
  useEffect(() => {
    if (!selectedTeam) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/team/${encodeURIComponent(selectedTeam)}/chats`, { cache: "no-store" });
        const d = await r.json();
        if (!cancelled && d.ok) setChats(d.chats);
        else if (!cancelled) { setError(d.error || "Could not load team chats."); setChats([]); }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setChats([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeam]);

  // Load team members for the new-chat modal
  useEffect(() => {
    if (!selectedTeam) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/team/${encodeURIComponent(selectedTeam)}/today`, { cache: "no-store" });
        const d = await r.json();
        if (!cancelled && d.ok) {
          setTeamMembers((d.members || []).map((m: { member_phone: string; member_name: string | null }) => ({
            member_phone: m.member_phone,
            member_name: m.member_name,
          })));
        }
      } catch { /* swallow */ }
    })();
    return () => { cancelled = true; };
  }, [selectedTeam]);

  // Load active chat detail when chat selection changes
  useEffect(() => {
    if (!selectedTeam || activeChatId === null) { setActiveChat(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/team/${encodeURIComponent(selectedTeam)}/chats/${activeChatId}`, { cache: "no-store" });
        const d = await r.json();
        if (!cancelled && d.ok) setActiveChat({ chat: d.chat, members: d.members, messages: d.messages });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedTeam, activeChatId]);

  // Poll for new messages every 6 seconds while a chat is open. SWR-lite.
  useEffect(() => {
    if (!selectedTeam || activeChatId === null) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/team/${encodeURIComponent(selectedTeam)}/chats/${activeChatId}`, { cache: "no-store" });
          const d = await r.json();
          if (d.ok) setActiveChat({ chat: d.chat, members: d.members, messages: d.messages });
        } catch { /* silent */ }
      })();
    }, 6000);
    return () => clearInterval(id);
  }, [selectedTeam, activeChatId]);

  async function refreshChats() {
    if (!selectedTeam) return;
    const r = await fetch(`/api/team/${encodeURIComponent(selectedTeam)}/chats`, { cache: "no-store" });
    const d = await r.json();
    if (d.ok) setChats(d.chats);
  }

  if (teams === null) {
    return <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading…</div>;
  }
  if (teams.length === 0) {
    return (
      <EmptyState
        icon="💬"
        title="Create a team first"
        body={
          <>
            Messages need a team. Head to <a href="/team" className="underline">Team</a> and create one — then come back here to start a group chat or DM.
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm">
          ⚠️ {error}
          <button onClick={() => setError(null)} className="ml-2 text-[#737373] hover:text-black">×</button>
        </div>
      )}

      {/* Team selector */}
      {!teamName && teams.length > 1 && (
        <div className="inline-flex gap-1 bg-white border border-[#E8E3ED] rounded-lg p-1">
          {teams.map(t => (
            <button
              key={t.name}
              onClick={() => { setSelectedTeam(t.name); setActiveChatId(null); }}
              className={`dash-tab ${selectedTeam === t.name ? "dash-tab-active" : ""}`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="grid lg:grid-cols-[320px,1fr] gap-4 min-h-[600px]">
        {/* Left rail */}
        <section className="dash-card overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-[#E8E3ED] flex items-center gap-2">
            <h3 className="dash-h2 flex-1">Chats</h3>
            <button onClick={() => setComposeOpen(true)} className="dash-btn dash-btn-primary !text-[12px] !py-1 !px-2.5" title="Create a new group chat">+ New group</button>
          </div>
          {chats === null ? (
            <div className="px-4 py-8 text-center text-[12px] text-[#a3a3a3]">Loading…</div>
          ) : (
            <UnifiedRail
              chats={chats}
              teamMembers={teamMembers}
              currentUserPhone={currentUserPhone}
              activeChatId={activeChatId}
              onPickChat={setActiveChatId}
              onPickMember={async (memberPhone, memberName) => {
                // Try existing DM first
                const existing = chats.find(c => c.type === "dm" && c.partner_phone === memberPhone);
                if (existing) { setActiveChatId(existing.id); return; }
                // Lazy-create
                if (!selectedTeam) return;
                try {
                  const r = await fetch(`/api/team/${encodeURIComponent(selectedTeam)}/chats`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ type: "dm", member_phones: [memberPhone] }),
                  });
                  const d = await r.json();
                  if (!d.ok) { setError(d.error || "Could not start chat."); return; }
                  setActiveChatId(d.chat.id);
                  void refreshChats();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
                void memberName; // suppress unused warning if we ever drop the arg later
              }}
            />
          )}
        </section>

        {/* Right pane */}
        <section className="dash-card overflow-hidden flex flex-col">
          {activeChat ? (
            <ChatThread
              chat={activeChat.chat}
              members={activeChat.members}
              messages={activeChat.messages}
              currentUserPhone={currentUserPhone}
              teamName={selectedTeam!}
              onSent={() => {
                // Re-pull messages immediately
                if (selectedTeam && activeChatId) {
                  fetch(`/api/team/${encodeURIComponent(selectedTeam)}/chats/${activeChatId}`, { cache: "no-store" })
                    .then(r => r.json())
                    .then(d => { if (d.ok) setActiveChat({ chat: d.chat, members: d.members, messages: d.messages }); })
                    .catch(() => {});
                  void refreshChats();
                }
              }}
              setError={setError}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-[13px] text-[#a3a3a3]">
              Pick a chat from the left, or start a new one.
            </div>
          )}
        </section>
      </div>

      <NewChatModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        teamName={selectedTeam || ""}
        members={teamMembers.filter(m => m.member_phone !== currentUserPhone)}
        onCreated={(chat) => {
          setComposeOpen(false);
          setActiveChatId(chat.id);
          void refreshChats();
        }}
      />
    </div>
  );
}

// ─── Unified left rail ─────────────────────────────────────────────────
//
// Combines:
//   - Existing groups (sorted by recent activity)
//   - Existing DMs (shown as the partner's name, not "DM")
//   - Team members who don't yet have a DM with the current user
//     (clickable; lazy-create on first click)
//
// One unified, scannable list. Removes the "+ New > pick type > pick
// member" friction for DMs — they're one tap from a list of all
// teammates.

function UnifiedRail({
  chats, teamMembers, currentUserPhone, activeChatId, onPickChat, onPickMember,
}: {
  chats: Chat[];
  teamMembers: Member[];
  currentUserPhone: string;
  activeChatId: number | null;
  onPickChat: (id: number) => void;
  onPickMember: (phone: string, name: string | null) => void | Promise<void>;
}) {
  // Build a set of members who already have an existing DM (so we
  // don't show them twice — once as a DM chat, once as a "start chat" row)
  const dmPartners = new Set(chats.filter(c => c.type === "dm" && c.partner_phone).map(c => c.partner_phone));
  const groups = chats.filter(c => c.type === "group");
  const dms = chats.filter(c => c.type === "dm");
  const orphanMembers = teamMembers.filter(m => m.member_phone !== currentUserPhone && !dmPartners.has(m.member_phone));

  if (groups.length === 0 && dms.length === 0 && orphanMembers.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[13px] text-[#737373]">
        No teammates available. Add members to your team first.
      </div>
    );
  }

  return (
    <ul className="flex-1 overflow-y-auto">
      {/* Groups */}
      {groups.length > 0 && (
        <>
          <li className="px-4 py-1.5 bg-[#FBFAFE] text-[10px] uppercase tracking-wider font-semibold text-[#737373] border-b border-[#E8E3ED]">
            Groups
          </li>
          {groups.map(c => (
            <ChatRow
              key={`g-${c.id}`}
              active={activeChatId === c.id}
              onClick={() => onPickChat(c.id)}
              icon="#"
              iconBg="#D8CCFF"
              title={c.name || "Untitled"}
              subtitle={`${c.member_count} ${c.member_count === 1 ? "member" : "members"} · ${fmtAgo(c.last_message_at || c.created_at)}`}
              unread={c.unread_count}
            />
          ))}
        </>
      )}

      {/* People (DMs) */}
      {(dms.length > 0 || orphanMembers.length > 0) && (
        <li className="px-4 py-1.5 bg-[#FBFAFE] text-[10px] uppercase tracking-wider font-semibold text-[#737373] border-b border-[#E8E3ED]">
          People
        </li>
      )}
      {dms.map(c => (
        <ChatRow
          key={`d-${c.id}`}
          active={activeChatId === c.id}
          onClick={() => onPickChat(c.id)}
          initialChar={(c.partner_name || c.partner_phone || "?").charAt(0).toUpperCase()}
          iconBg="#6E49E8"
          title={c.partner_name || `+${c.partner_phone || ""}`}
          subtitle={c.last_message_at ? fmtAgo(c.last_message_at) : "Direct message"}
          unread={c.unread_count}
        />
      ))}
      {orphanMembers.map(m => (
        <ChatRow
          key={`m-${m.member_phone}`}
          active={false}
          onClick={() => { void onPickMember(m.member_phone, m.member_name); }}
          initialChar={(m.member_name || "?").charAt(0).toUpperCase()}
          iconBg="#6E49E8"
          iconDimmed
          title={m.member_name || `+${m.member_phone}`}
          subtitle="Start a chat"
          unread={0}
        />
      ))}
    </ul>
  );
}

function ChatRow({
  active, onClick, icon, initialChar, iconBg, iconDimmed, title, subtitle, unread,
}: {
  active: boolean;
  onClick: () => void;
  icon?: string;
  initialChar?: string;
  iconBg: string;
  iconDimmed?: boolean;
  title: string;
  subtitle: string;
  unread: number;
}) {
  return (
    <li className="border-b border-[#E8E3ED] last:border-b-0">
      <button
        onClick={onClick}
        className={`w-full text-left px-4 py-3 hover:bg-[#FBFAFE] transition-colors ${active ? "bg-[#FBFAFE]" : ""}`}
      >
        <div className="flex items-center gap-2">
          <div
            className={`w-7 h-7 rounded-full border border-[#0a0a0a] flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${iconDimmed ? "opacity-50" : ""}`}
            style={{ background: iconBg }}
          >
            {icon || initialChar || "?"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className={`text-[13px] truncate ${unread > 0 ? "font-semibold" : "font-medium"} ${iconDimmed ? "text-[#737373]" : ""}`}>
                {title}
              </span>
              {unread > 0 && (
                <span className="text-[9.5px] font-bold uppercase tracking-wider text-white bg-[#8A65FF] border border-[#0a0a0a] rounded px-1.5 py-0.5 num">
                  {unread}
                </span>
              )}
            </div>
            <div className={`text-[11px] truncate ${iconDimmed ? "text-[#a3a3a3]" : "text-[#737373]"}`}>
              {subtitle}
            </div>
          </div>
        </div>
      </button>
    </li>
  );
}

// ─── Thread view ───────────────────────────────────────────────────────

function ChatThread({
  chat, members, messages, currentUserPhone, teamName, onSent, setError,
}: {
  chat: Chat;
  members: ChatMember[];
  messages: ChatMessage[];
  currentUserPhone: string;
  teamName: string;
  onSent: () => void;
  setError: (s: string | null) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  const otherMembers = useMemo(() => members.filter(m => m.member_phone !== currentUserPhone), [members, currentUserPhone]);
  // For DMs prefer the server-computed partner_name (it's the source of
  // truth in the chat list); fall back to the members lookup for older
  // chats that pre-date the partner column being populated.
  const headerName = chat.type === "dm"
    ? (chat.partner_name || otherMembers[0]?.member_name || `+${chat.partner_phone || otherMembers[0]?.member_phone || ""}`)
    : (chat.name || "Untitled chat");
  const subtitle = chat.type === "dm"
    ? `Direct message`
    : `${members.length} members: ${members.map(m => m.member_name || `+${m.member_phone}`).slice(0, 4).join(", ")}${members.length > 4 ? `, +${members.length - 4}` : ""}`;

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/chats/${chat.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not send."); return; }
      setDraft("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="px-5 py-3 border-b border-[#E8E3ED]">
        <div className="text-[14px] font-semibold truncate">{headerName}</div>
        <div className="text-[11.5px] text-[#737373] truncate">{subtitle}</div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.length === 0 ? (
          <div className="text-center text-[13px] text-[#a3a3a3] py-8">
            No messages yet. Send the first one below — it&apos;ll show up here for {otherMembers.length === 1 ? otherMembers[0].member_name || "the recipient" : `your ${otherMembers.length} teammates`}, with a WhatsApp ping if they don&apos;t check within 45 min.
          </div>
        ) : messages.map(m => {
          const mine = m.from_phone === currentUserPhone;
          return (
            <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"} gap-2`}>
              {!mine && (
                <div className="w-7 h-7 rounded-full bg-[#6E49E8] border border-[#0a0a0a] text-[11px] font-bold flex items-center justify-center flex-shrink-0">
                  {(m.from_name || "?").charAt(0).toUpperCase()}
                </div>
              )}
              <div className={`max-w-[70%] ${mine ? "items-end" : "items-start"} flex flex-col`}>
                {!mine && chat.type !== "dm" && (
                  <div className="text-[10.5px] text-[#737373] mb-0.5 px-1">{m.from_name || `+${m.from_phone}`}</div>
                )}
                <div className={`px-3 py-2 rounded-lg leading-relaxed text-[13.5px] break-words whitespace-pre-wrap border ${
                  mine
                    ? "bg-[#8A65FF]/40 border-[#8A65FF]"
                    : "bg-white border-[#E8E3ED]"
                }`}>
                  {m.text}
                </div>
                <div className="text-[10px] text-[#a3a3a3] mt-0.5 px-1 flex items-center gap-1.5">
                  <span>{fmtTime(m.created_at)}</span>
                  {m.sent_via === "whatsapp" && <span>📱 WhatsApp</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-[#E8E3ED] px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Type a message…"
            className="dash-input flex-1 resize-none leading-relaxed"
          />
          <button onClick={send} disabled={busy || !draft.trim()} className="dash-btn dash-btn-primary disabled:opacity-40">
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
        <div className="text-[10.5px] text-[#a3a3a3] mt-1.5">
          Recipients see this in the dashboard. If they don&apos;t check within 45 min, Ari sends one WhatsApp notification.
        </div>
      </div>
    </>
  );
}

// ─── New chat modal ────────────────────────────────────────────────────

function NewChatModal({
  open, onClose, teamName, members, onCreated,
}: {
  open: boolean; onClose: () => void; teamName: string;
  members: Member[];
  onCreated: (chat: Chat) => void;
}) {
  // Group-only — DMs are now one-tap from the left rail (no modal needed).
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setName(""); setPicked(new Set()); setError(null); }
  }, [open]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const phones = Array.from(picked);
      if (!name.trim()) { setError("Group name required"); return; }
      if (phones.length === 0) { setError("Pick at least one teammate"); return; }

      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "group", name: name.trim(), member_phones: phones }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not create."); return; }
      onCreated(d.chat);
    } finally { setBusy(false); }
  }

  function togglePicked(phone: string) {
    setPicked(p => {
      const next = new Set(p);
      if (next.has(phone)) next.delete(phone); else next.add(phone);
      return next;
    });
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-12 pb-12 px-4 bg-black/40 overflow-y-auto" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white border border-black/15 rounded-[8px] shadow-[0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-5 py-4 border-b border-black/10">
          <div className="dash-label">Team {teamName}</div>
          <h2 className="text-[18px] font-bold mt-0.5">New group</h2>
          <div className="text-[11.5px] text-[#737373] mt-0.5">
            For 1-1 chats, just pick a teammate from the list — no group needed.
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}

          <div>
            <label className="dash-label block mb-1.5">Group name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="design-team / launch-prep / standups"
              className="dash-input w-full"
            />
          </div>

          <div>
            <label className="dash-label block mb-1.5">Pick teammates *</label>
            <div className="dash-card overflow-hidden">
              <ul className="max-h-[240px] overflow-y-auto">
                {members.length === 0 ? (
                  <li className="px-3 py-3 text-center text-[12.5px] text-[#a3a3a3]">No teammates available.</li>
                ) : members.map(m => (
                  <li key={m.member_phone}>
                    <button
                      onClick={() => togglePicked(m.member_phone)}
                      className={`w-full flex items-center gap-3 px-3 py-2 hover:bg-[#FBFAFE] transition-colors text-left border-b border-[#E8E3ED] last:border-b-0 ${picked.has(m.member_phone) ? "bg-[#FBFAFE]" : ""}`}
                    >
                      <span className={`w-4 h-4 rounded border ${picked.has(m.member_phone) ? "bg-[#0a0a0a] border-[#0a0a0a]" : "border-[#a3a3a3]"} flex items-center justify-center flex-shrink-0`}>
                        {picked.has(m.member_phone) && <span className="text-white text-[10px]">✓</span>}
                      </span>
                      <span className="text-[13px] flex-1 truncate">{m.member_name || `+${m.member_phone}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            {picked.size > 0 && (
              <div className="text-[11px] text-[#a3a3a3] mt-1">{picked.size} picked</div>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between bg-[#FBFAFE]/40">
          <button onClick={onClose} className="text-[13px] text-[#737373] hover:text-black">Cancel</button>
          <button onClick={submit} disabled={busy || picked.size === 0 || !name.trim()} className="dash-btn dash-btn-primary disabled:opacity-40">
            {busy ? "Creating…" : "Create group"}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return `${days}d`;
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
