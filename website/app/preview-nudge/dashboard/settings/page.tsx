"use client";

import { useState } from "react";
import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";

const integrations = [
  { name: "Google Calendar",  status: "Connected",    host: "google.com",    note: "danish@ari.local · 3 calendars" },
  { name: "Gmail",            status: "Connected",    host: "google.com",    note: "danish@ari.local · 2 accounts" },
  { name: "Meeting Recorder", status: "Ready",        host: "assemblyai.com", note: "manual system + microphone capture" },
  { name: "Google Drive",     status: "Connected",    host: "google.com",    note: "Read & write" },
  { name: "WhatsApp",         status: "Connected",    host: "whatsapp.com",  note: "+91 98xxx xx123" },
  { name: "Microsoft Outlook",status: "Disconnected", host: "microsoft.com", note: "—" },
  { name: "Microsoft Teams",  status: "Disconnected", host: "microsoft.com", note: "—" },
  { name: "Zoom",             status: "Disconnected", host: "zoom.us",       note: "—" },
  { name: "Slack",            status: "Disconnected", host: "slack.com",     note: "—" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState("profile");

  return (
    <DashboardShell title="settings">
      <PageHead
        title="Settings"
        subtitle="Account, integrations, and notification preferences. Everything Ari needs to know about you."
        badge={{ label: "Free · full access", color: "#9BE7BF" }}
        actions={<button className="dash-btn">Help</button>}
      />

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "profile",       label: "Profile" },
          { value: "integrations",  label: "Integrations", count: 5 },
          { value: "notifications", label: "Notifications" },
          { value: "security",      label: "Security" },
        ]}
      />

      <div className="mt-6">
        {tab === "profile" && <ProfilePanel />}
        {tab === "integrations" && <IntegrationsPanel />}
        {tab === "notifications" && <NotificationsPanel />}
        {tab === "security" && <SecurityPanel />}
      </div>
    </DashboardShell>
  );
}

/* ───────── Profile ───────── */
function ProfilePanel() {
  return (
    <div className="grid lg:grid-cols-[1.6fr,1fr] gap-5">
      <section className="dash-card-hero p-6">
        <h2 className="dash-h2 mb-5">Profile</h2>
        <div className="space-y-4">
          <Field label="Display name" value="Danish" />
          <Field label="Email" value="danish@ari.local" />
          <Field label="WhatsApp number" value="+91 98xxx xx123" />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Timezone" value="Asia/Calcutta (GMT+5:30)" />
            <Field label="Locale" value="en-IN" />
          </div>
          <Field label="Preferred AI tone" value="Friendly · concise" />
        </div>
        <div className="flex gap-2 mt-6 pt-5 border-t border-[#efece2]">
          <button className="dash-btn dash-btn-primary">Save changes</button>
          <button className="dash-btn">Cancel</button>
        </div>
      </section>

      <section className="space-y-5">
        <div className="dash-card p-5">
          <h3 className="dash-h2 mb-3">Avatar</h3>
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-[#FF9D6E] border border-[#0a0a0a] flex items-center justify-center text-[18px] font-bold">
              A
            </div>
            <div>
              <button className="dash-btn !text-[12px]">Upload</button>
              <p className="text-[11px] text-[#a3a3a3] mt-2">PNG, JPG · max 2MB</p>
            </div>
          </div>
        </div>
        <div className="dash-card p-5">
          <h3 className="dash-h2 mb-3">Workspace</h3>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-[#9BE7BF] border border-[#0a0a0a] flex items-center justify-center text-[14px] font-bold">
              S
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium truncate">Ari HQ</div>
              <div className="text-[11px] text-[#737373]">6 members · full access</div>
            </div>
          </div>
          <button className="dash-btn !text-[12px] mt-4 w-full justify-center">
            Manage workspace
          </button>
        </div>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="dash-label block mb-1.5">{label}</label>
      <input type="text" defaultValue={value} className="dash-input w-full" />
    </div>
  );
}

/* ───────── Integrations ───────── */
function IntegrationsPanel() {
  return (
    <section className="dash-card-hero overflow-hidden">
      <div className="px-6 py-5 border-b border-[#0a0a0a]/15 flex items-center justify-between">
        <h2 className="dash-h2">Connected accounts</h2>
        <span className="text-[11px] text-[#737373]">5 of 9 connected</span>
      </div>
      <ul>
        {integrations.map((it, i) => (
          <li
            key={it.name}
            className={`flex items-center gap-4 px-6 py-4 hover:bg-[#fbfaf3] ${
              i !== integrations.length - 1 ? "border-b border-[#efece2]" : ""
            }`}
          >
            <div className="w-9 h-9 rounded-md bg-[#fbfaf3] border border-[#e8e6dc] flex items-center justify-center flex-shrink-0">
              <img
                src={`https://www.google.com/s2/favicons?domain=${it.host}&sz=64`}
                alt=""
                className="w-4 h-4"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold truncate">{it.name}</div>
              <div className="text-[11px] text-[#737373] truncate mt-0.5">
                {it.note}
              </div>
            </div>
            <StatusPill color={it.status === "Connected" ? "#3FAA6E" : "#a3a3a3"}>
              {it.status}
            </StatusPill>
            <button className="dash-btn !py-1.5 !px-3 !text-[12px]">
              {it.status === "Connected" ? "Manage" : "Connect"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ───────── Notifications ───────── */
function NotificationsPanel() {
  return (
    <section className="dash-card-hero p-6">
      <h2 className="dash-h2 mb-5">Notification preferences</h2>
      <div className="space-y-3">
        {[
          { label: "Daily briefing every morning", desc: "7:00 AM IST · WhatsApp", on: true },
          { label: "Reminder nudges",              desc: "5 min before each reminder fires", on: true },
          { label: "Meeting prep summary",         desc: "10 min before each meeting", on: true },
          { label: "Email — important only",        desc: "Filtered, not all", on: true },
          { label: "Weekly productivity review",    desc: "Monday 9 AM", on: false },
          { label: "Marketing & product updates",   desc: "From the Ari team", on: false },
        ].map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-4 px-4 py-3 rounded-md border border-[#e8e6dc] bg-white hover:border-[#d4d4d4]"
          >
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium">{row.label}</div>
              <div className="text-[11.5px] text-[#737373] mt-0.5">{row.desc}</div>
            </div>
            <Toggle on={row.on} />
          </div>
        ))}
      </div>
    </section>
  );
}

function Toggle({ on }: { on: boolean }) {
  return (
    <button
      className={`w-9 h-5 rounded-full border border-[#0a0a0a] relative transition-colors ${
        on ? "bg-[#0a0a0a]" : "bg-white"
      }`}
    >
      <span
        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all ${
          on ? "left-[18px] bg-white" : "left-0.5 bg-[#0a0a0a]"
        }`}
      />
    </button>
  );
}

/* ───────── Security ───────── */
function SecurityPanel() {
  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <section className="dash-card p-6">
        <h2 className="dash-h2 mb-4">Two-factor authentication</h2>
        <p className="text-[12.5px] text-[#525252] leading-relaxed mb-4">
          Adds a one-time code from your authenticator app on top of your usual login.
        </p>
        <StatusPill color="#3FAA6E">Enabled · Authenticator app</StatusPill>
        <div className="flex gap-2 mt-4">
          <button className="dash-btn">Reset</button>
          <button className="dash-btn">View backup codes</button>
        </div>
      </section>
      <section className="dash-card p-6">
        <h2 className="dash-h2 mb-4">Active sessions</h2>
        <ul className="space-y-3 text-[12.5px]">
          {[
            { device: "Chrome · macOS · Bengaluru",   when: "Now",          current: true },
            { device: "Safari · iOS · Bengaluru",     when: "2h ago",       current: false },
            { device: "Chrome · Windows · Mumbai",    when: "Yesterday",    current: false },
          ].map((s) => (
            <li key={s.device} className="flex items-center gap-3">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  s.current ? "bg-[#3FAA6E]" : "bg-[#a3a3a3]"
                }`}
              />
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] truncate">{s.device}</span>
                <span className="block text-[11px] text-[#a3a3a3] num">{s.when}</span>
              </span>
              {!s.current && (
                <button className="dash-btn !py-1 !px-2 !text-[11px]">Revoke</button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="dash-card p-6 lg:col-span-2 border-[#ef4444] bg-[#fff5f5]" style={{ borderRadius: 10 }}>
        <h2 className="dash-h2 mb-2 text-[#991b1b]">Danger zone</h2>
        <p className="text-[12.5px] text-[#7f1d1d] leading-relaxed mb-4">
          Permanently delete your account and all associated data. This action is irreversible — Ari retains nothing after 30 days.
        </p>
        <button className="dash-btn !text-[#991b1b] !border-[#ef4444] hover:!bg-[#fee2e2]">
          Delete account
        </button>
      </section>
    </div>
  );
}
