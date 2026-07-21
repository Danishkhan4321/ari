"use client";

import { useState } from "react";
import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";

const emails = [
  { from: "Stripe", subject: "Your weekly invoice summary", preview: "Hi Danish, here's your activity for the week of April 22…", time: "9:42 AM", unread: true, label: "Finance", labelColor: "#9BE7BF", important: false },
  { from: "Priya Sharma", subject: "Re: Q3 GTM doc — initial thoughts", preview: "Thanks for sharing this! Couple of thoughts on positioning before we lock in…", time: "9:15 AM", unread: true, label: "Work", labelColor: "#7BD3F7", important: true },
  { from: "GitHub", subject: "[ari] Pull request #248 needs review", preview: "Danish opened a pull request: feat: add meeting report cache…", time: "8:52 AM", unread: true, label: "Dev", labelColor: "#B7A8FF", important: false },
  { from: "Sequoia · Roelof", subject: "Following up on our pitch", preview: "Hey Danish — really enjoyed the conversation yesterday. Let's set up a follow-up…", time: "Yesterday", unread: false, label: "Investor", labelColor: "#FFE38C", important: true },
  { from: "Zoom", subject: "Recording available — Pitch call with Sequoia", preview: "Your meeting recording is ready. Click below to view, share, or download…", time: "Yesterday", unread: false, label: "Meetings", labelColor: "#FFB1D8", important: false },
  { from: "Acme Inc · Sarah", subject: "Demo feedback + next steps", preview: "Hi Danish, the team really enjoyed the demo. We'd love to discuss enterprise pricing…", time: "Yesterday", unread: false, label: "Sales", labelColor: "#FF9D6E", important: true },
  { from: "Notion", subject: "Weekly digest for Ari", preview: "5 pages updated, 12 new comments, 3 new collaborators…", time: "Mon", unread: false, label: "Updates", labelColor: "#a3a3a3", important: false },
];

export default function EmailPage() {
  const [folder, setFolder] = useState("inbox");
  const [selected, setSelected] = useState(0);
  const unread = emails.filter((e) => e.unread).length;

  return (
    <DashboardShell title="email">
      <PageHead
        title="Inbox"
        subtitle={`${unread} unread · all your accounts in one view. Send, schedule, and search emails through chat.`}
        badge={{ label: "Email · synced 2m ago", color: "#FFB1D8" }}
        actions={
          <>
            <button className="dash-btn">Filter</button>
            <button className="dash-btn dash-btn-primary">+ Compose</button>
          </>
        }
      />

      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <Tabs
          value={folder}
          onChange={setFolder}
          options={[
            { value: "inbox", label: "Inbox", count: unread },
            { value: "important", label: "Important", count: 3 },
            { value: "sent", label: "Sent" },
            { value: "drafts", label: "Drafts", count: 2 },
            { value: "archive", label: "Archive" },
          ]}
        />
        <div className="flex items-center gap-2">
          <StatusPill color="#7BD3F7">Gmail</StatusPill>
          <StatusPill color="#FFE38C">Outlook</StatusPill>
        </div>
      </div>

      {/* Two-pane: list + reader */}
      <div className="grid lg:grid-cols-[1fr,1.4fr] gap-5">
        {/* List */}
        <section className="dash-card-hero overflow-hidden">
          <ul>
            {emails.map((e, i) => (
              <li
                key={i}
                onClick={() => setSelected(i)}
                className={`cursor-pointer px-5 py-4 transition-colors ${
                  i === selected
                    ? "bg-[#FFE38C]/30"
                    : "hover:bg-[#fbfaf3]"
                } ${i !== emails.length - 1 ? "border-b border-[#efece2]" : ""}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {e.unread && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#7BD3F7]" />
                  )}
                  {e.important && (
                    <span className="text-[#F59E0B] text-[12px]">★</span>
                  )}
                  <span
                    className={`text-[12.5px] truncate flex-1 ${
                      e.unread ? "font-semibold text-[#0a0a0a]" : "font-medium text-[#525252]"
                    }`}
                  >
                    {e.from}
                  </span>
                  <span className="text-[10.5px] text-[#a3a3a3] num flex-shrink-0">
                    {e.time}
                  </span>
                </div>
                <div
                  className={`text-[13px] truncate ${
                    e.unread ? "text-[#0a0a0a] font-medium" : "text-[#525252]"
                  }`}
                >
                  {e.subject}
                </div>
                <div className="text-[11.5px] text-[#a3a3a3] truncate mt-0.5">
                  {e.preview}
                </div>
                <div className="mt-2">
                  <StatusPill color={e.labelColor}>{e.label}</StatusPill>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Reader */}
        <section className="dash-card overflow-hidden flex flex-col">
          <div className="px-6 py-5 border-b border-[#e8e6dc]">
            <div className="flex items-center gap-2 mb-1">
              <StatusPill color={emails[selected].labelColor}>
                {emails[selected].label}
              </StatusPill>
              <span className="text-[11px] text-[#a3a3a3] num">
                {emails[selected].time}
              </span>
            </div>
            <h2 className="text-[18px] font-semibold tracking-tight mt-2">
              {emails[selected].subject}
            </h2>
            <div className="flex items-center gap-2.5 mt-3">
              <div className="w-7 h-7 rounded-full bg-[#7BD3F7] border border-[#0a0a0a] text-[#0a0a0a] flex items-center justify-center text-[11px] font-bold">
                {emails[selected].from.split(" ").map((s) => s[0]).slice(0, 2).join("")}
              </div>
              <div>
                <div className="text-[12.5px] font-medium">{emails[selected].from}</div>
                <div className="text-[11px] text-[#737373]">to danish@ari.local</div>
              </div>
            </div>
          </div>

          <div className="px-6 py-6 flex-1 overflow-y-auto text-[13.5px] leading-[1.65] text-[#404040]">
            <p>Hi Danish,</p>
            <p className="mt-3">{emails[selected].preview}</p>
            <p className="mt-3">
              Looking forward to your response. Let me know what works for you and
              I&apos;ll get a calendar invite over.
            </p>
            <p className="mt-3">Best,</p>
            <p>{emails[selected].from.split(" ")[0]}</p>
          </div>

          {/* Reply bar */}
          <div className="px-6 py-4 border-t border-[#e8e6dc] flex items-center gap-2 flex-wrap">
            <button className="dash-btn dash-btn-primary">↩ Reply</button>
            <button className="dash-btn">Reply all</button>
            <button className="dash-btn">Forward</button>
            <div className="ml-auto flex gap-2">
              <button className="dash-btn">Snooze</button>
              <button className="dash-btn">Archive</button>
            </div>
          </div>

          {/* Ari suggested reply */}
          <div className="border-t border-[#e8e6dc] px-6 py-4 bg-[#0E0E0C] text-white">
            <div className="flex items-center gap-2 mb-2 text-[11px] uppercase tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-[#7BD3F7] animate-pulse" />
              Ari suggests
            </div>
            <p className="text-[13px] text-white/85 leading-relaxed">
              &ldquo;Thanks for the quick follow-up! How does Tuesday at 3 PM IST
              work for a 30-minute call? Happy to share the deck beforehand.&rdquo;
            </p>
            <div className="flex gap-2 mt-3">
              <button className="text-[11px] font-medium bg-[#7BD3F7] text-[#0a0a0a] px-3 py-1.5 rounded">
                Use draft
              </button>
              <button className="text-[11px] font-medium text-white/70 hover:text-white">
                Regenerate
              </button>
            </div>
          </div>
        </section>
      </div>
    </DashboardShell>
  );
}
