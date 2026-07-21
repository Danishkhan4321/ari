"use client";

import { useState } from "react";
import { DashboardShell, PageHead, StatusPill } from "../_shell";

type Msg = { from: "ari" | "you"; text: string; time: string };

const seed: Msg[] = [
  { from: "ari", text: "Good afternoon, Danish. You've got 2 meetings, 7 tasks, and 23 unread emails today. Anything you want to tackle first?", time: "2:14 PM" },
  { from: "you", text: "Move my 4pm meeting to tomorrow same time and email Priya about it", time: "2:15 PM" },
  { from: "ari", text: "Done — moved \"Demo for Acme\" from today 4:30 PM to tomorrow 4:30 PM and sent Priya a heads-up via Gmail. Want me to also reschedule the prep block before it?", time: "2:15 PM" },
  { from: "you", text: "Yes, and remind me to review Q3 budget every Friday at 5pm", time: "2:16 PM" },
  { from: "ari", text: "Recurring reminder set: every Friday at 5:00 PM IST — \"Review Q3 budget.\" First fires this Friday. Snooze or change anytime.", time: "2:16 PM" },
];

const suggestions = [
  "Show today's agenda",
  "Schedule a 30-min call with Raj tomorrow",
  "Find Stripe pricing in my notes",
  "Draft a follow-up to Sequoia",
  "Summarize last meeting",
  "What did Priya say about Q3?",
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>(seed);
  const [input, setInput] = useState("");

  const send = (text?: string) => {
    const t = (text ?? input).trim();
    if (!t) return;
    setMessages((m) => [...m, { from: "you", text: t, time: "now" }]);
    setInput("");
    setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          from: "ari",
          text:
            "Got it — I'll handle that. (This is a UI preview; the production chat connects to the bot backend.)",
          time: "now",
        },
      ]);
    }, 600);
  };

  return (
    <DashboardShell title="chat">
      <PageHead
        title="Chat with Ari"
        subtitle="Same conversation as WhatsApp — synced. Type anything you'd say to your assistant."
        badge={{ label: "Live · synced with WhatsApp", color: "#3FAA6E" }}
        actions={
          <>
            <button className="dash-btn">History</button>
            <button className="dash-btn">⌘ K</button>
          </>
        }
      />

      <div className="grid lg:grid-cols-[1fr,280px] gap-5">
        {/* Conversation */}
        <section className="dash-card-hero overflow-hidden flex flex-col h-[640px]">
          {/* Header bar */}
          <div className="px-6 py-4 border-b border-[#0a0a0a]/15 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="relative w-9 h-9 flex items-center justify-center">
                <span className="absolute inset-0 rounded-full bg-[#9BE7BF] opacity-50 blur-sm" />
                <img
                  src="/logo-wolf.png"
                  alt=""
                  className="relative w-9 h-9 object-contain"
                />
              </div>
              <div>
                <div className="text-[14px] font-semibold leading-none">Ari</div>
                <div className="text-[11px] text-[#737373] mt-1 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#3FAA6E] animate-pulse" />
                  Online · responds in seconds
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusPill color="#7BD3F7">Full access</StatusPill>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.from === "you" ? "justify-end" : "justify-start"}`}
              >
                <div className="max-w-[75%]">
                  <div
                    className={`px-4 py-3 text-[13.5px] leading-relaxed rounded-2xl ${
                      m.from === "you"
                        ? "bg-[#0a0a0a] text-white rounded-br-md"
                        : "bg-[#fbfaf3] border border-[#e8e6dc] text-[#0a0a0a] rounded-bl-md"
                    }`}
                  >
                    {m.text}
                  </div>
                  <div
                    className={`text-[10.5px] text-[#a3a3a3] mt-1 num ${
                      m.from === "you" ? "text-right" : ""
                    }`}
                  >
                    {m.time}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Composer */}
          <div className="px-5 py-4 border-t border-[#0a0a0a]/15 bg-[#fbfaf3]">
            <div className="flex items-center gap-2">
              <button className="w-9 h-9 rounded-md border border-[#e8e6dc] bg-white flex items-center justify-center text-[#737373] hover:border-[#0a0a0a]">
                +
              </button>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Message Ari…"
                className="dash-input flex-1"
              />
              <button
                onClick={() => send()}
                className="dash-btn dash-btn-primary"
                disabled={!input.trim()}
              >
                Send →
              </button>
            </div>
            <div className="text-[10.5px] text-[#a3a3a3] mt-2 px-1">
              Same chat as your WhatsApp · End-to-end encrypted
            </div>
          </div>
        </section>

        {/* Right rail */}
        <aside className="space-y-5">
          <section className="dash-card overflow-hidden">
            <div className="px-4 py-3 border-b border-[#e8e6dc]">
              <h3 className="dash-h2">Quick prompts</h3>
            </div>
            <div className="p-3 space-y-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="w-full text-left text-[12.5px] px-3 py-2 rounded-md hover:bg-[#fbfaf3] border border-transparent hover:border-[#e8e6dc] transition-colors text-[#404040]"
                >
                  {s}
                </button>
              ))}
            </div>
          </section>

          <section className="dash-card p-4">
            <h3 className="dash-h2 mb-3">Connected to</h3>
            <ul className="space-y-2 text-[12px]">
              {[
                ["WhatsApp", "#9BE7BF"],
                ["Gmail", "#FFB1D8"],
                ["Calendar", "#7BD3F7"],
                ["Meet", "#FFE38C"],
              ].map(([n, c]) => (
                <li key={n} className="flex items-center gap-2 text-[#525252]">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: c as string }}
                  />
                  {n}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </DashboardShell>
  );
}
