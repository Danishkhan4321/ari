"use client";

import { useEffect, useState } from "react";
import { SkeletonList, SkeletonCard } from "@/components/skeletons";
import { GoogleProductIcon } from "@/components/google-product-icon";

type Settings = {
  user_phone: string;
  google: { connected?: boolean; allConnected?: boolean; products?: Partial<Record<GoogleProduct, boolean>>; google_email: string | null; scopes: string | null } | null;
  microsoft: { microsoft_email: string | null } | null;
  dashboardSessions: { count: string; latest: string | null } | null;
};

type DesktopAIStatus = {
  available: boolean;
  connected: boolean;
  provider: "ari" | "codex";
  model: "auto" | "sol" | "terra" | "luna";
  account?: string | null;
  error?: string | null;
};

type DictationStatus = {
  available: boolean;
  enabled: boolean;
  state: string;
  platform: string;
  accessibility: string;
  microphone: string;
  shortcuts: { pushToTalk: string; handsFree: string; pasteLast: string };
  lastTranscriptAvailable: boolean;
  error?: string | null;
};

declare global {
  interface Window {
    ariDesktop?: {
      ai: {
        getStatus: () => Promise<DesktopAIStatus>;
        connectCodex: () => Promise<DesktopAIStatus & { ok: boolean }>;
        disconnectCodex: () => Promise<DesktopAIStatus & { ok: boolean }>;
        setPreference: (preference: Partial<Pick<DesktopAIStatus, "provider" | "model">>) => Promise<DesktopAIStatus & { ok: boolean }>;
      };
      dictation: {
        getStatus: () => Promise<DictationStatus>;
        setEnabled: (enabled: boolean) => Promise<DictationStatus>;
        pasteLast: () => Promise<{ ok: boolean }>;
        testMicrophone: () => Promise<{ ok: boolean }>;
        listRecent: () => Promise<{ ok: boolean; items: Array<{ id: string; text: string; createdAt: string; pasted: boolean }> }>;
        copyRecent: (transcriptId: string) => Promise<{ ok: boolean }>;
      };
    };
  }
}

export function SettingsContent() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<DesktopAIStatus | null>(null);
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  const [aiBusy, setAiBusy] = useState<"connect" | "disconnect" | "preference" | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [dictation, setDictation] = useState<DictationStatus | null>(null);
  const [dictationBusy, setDictationBusy] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/overview", { cache: "no-store" })
      .then(r => r.json())
      .then(d => d.ok ? setS(d) : setError(d.error || "Could not load."))
      .catch(e => setError(String(e)));
    if (window.ariDesktop?.ai) {
      setDesktopAvailable(true);
      window.ariDesktop.ai.getStatus()
        .then(setAi)
        .catch((e) => setAiError(String(e)));
    }
    if (window.ariDesktop?.dictation) {
      window.ariDesktop.dictation.getStatus()
        .then(setDictation)
        .catch((e) => setDictationError(String(e)));
    }
  }, []);

  async function toggleDictation(enabled: boolean) {
    if (!window.ariDesktop?.dictation) return;
    setDictationBusy(true);
    setDictationError(null);
    try {
      setDictation(await window.ariDesktop.dictation.setEnabled(enabled));
    } catch (e) {
      setDictationError(e instanceof Error ? e.message : String(e));
    } finally {
      setDictationBusy(false);
    }
  }

  async function testMicrophone() {
    if (!window.ariDesktop?.dictation) return;
    setDictationBusy(true);
    setDictationError(null);
    try {
      await window.ariDesktop.dictation.testMicrophone();
      setDictation(await window.ariDesktop.dictation.getStatus());
    } catch (e) {
      setDictationError(e instanceof Error ? e.message : String(e));
    } finally {
      setDictationBusy(false);
    }
  }

  async function connectCodex() {
    if (!window.ariDesktop?.ai) return;
    setAiBusy("connect");
    setAiError(null);
    try {
      const result = await window.ariDesktop.ai.connectCodex();
      if (!result.ok) setAiError(result.error || "Codex sign-in did not complete.");
      setAi(await window.ariDesktop.ai.getStatus());
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(null);
    }
  }

  async function disconnectCodex() {
    if (!window.ariDesktop?.ai) return;
    setAiBusy("disconnect");
    setAiError(null);
    try {
      await window.ariDesktop.ai.disconnectCodex();
      setAi(await window.ariDesktop.ai.getStatus());
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(null);
    }
  }

  async function setAI(value: Partial<Pick<DesktopAIStatus, "provider" | "model">>) {
    if (!window.ariDesktop?.ai) return;
    setAiBusy("preference");
    setAiError(null);
    try {
      const result = await window.ariDesktop.ai.setPreference(value);
      if (!result.ok) throw new Error(result.error || "Could not update AI settings.");
      setAi((current) => current ? { ...current, ...result } : result);
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(null);
    }
  }

  async function connectGoogle(product: GoogleProduct | "all") {
    setGoogleBusy(true);
    setGoogleError(null);
    try {
      const response = await fetch("/api/settings/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.url) throw new Error(result.error || "Could not start Google connection.");
      window.open(result.url, "ari-google-connect", "popup,width=620,height=760");
    } catch (e) {
      setGoogleError(e instanceof Error ? e.message : String(e));
    } finally {
      setGoogleBusy(false);
    }
  }

  if (!s) return error
    ? <div className="card-soft bg-card-orange/30 px-4 py-3 text-sm">⚠️ {error}</div>
    : <SkeletonList count={4} />;

  return (
    <div className="space-y-5">
      <Card title="AI agent">
        {!desktopAvailable ? (
          <div className="rounded-xl border border-ari-border bg-ari-soft/50 px-4 py-3 text-sm text-ari-muted">
            Codex connection is available in the Ari desktop app. Ari AI is active in this browser.
          </div>
        ) : !ai ? (
          <SkeletonCard />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={Boolean(aiBusy) || !ai.connected}
                onClick={() => setAI({ provider: "codex" })}
                className={`rounded-xl border p-4 text-left transition ${ai.provider === "codex" ? "border-ari-violet-500 bg-ari-soft ring-1 ring-ari-violet-200" : "border-ari-border bg-white hover:border-ari-violet-300"} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-ari-text">Codex</span>
                  <span className={`h-2 w-2 rounded-full ${ai.connected ? "bg-emerald-500" : "bg-ari-border"}`} />
                </span>
                <span className="mt-1 block text-xs leading-5 text-ari-muted">Use your connected Codex account for Ari&apos;s planning and tool use.</span>
              </button>
              <button
                type="button"
                disabled={Boolean(aiBusy)}
                onClick={() => setAI({ provider: "ari" })}
                className={`rounded-xl border p-4 text-left transition ${ai.provider === "ari" ? "border-ari-violet-500 bg-ari-soft ring-1 ring-ari-violet-200" : "border-ari-border bg-white hover:border-ari-violet-300"} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                <span className="font-semibold text-ari-text">Ari AI</span>
                <span className="mt-1 block text-xs leading-5 text-ari-muted">Built-in model and automatic fallback when Codex is unavailable.</span>
              </button>
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-ari-border bg-[#fcfbfd] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium text-ari-text">Codex account</div>
                <div className="mt-0.5 text-xs text-ari-muted">{ai.connected ? (ai.account || "Connected") : "Not connected"}</div>
              </div>
              {ai.connected ? (
                <button type="button" disabled={Boolean(aiBusy)} onClick={disconnectCodex} className="rounded-lg border border-ari-border bg-white px-3 py-2 text-xs font-medium text-ari-text hover:bg-ari-soft disabled:opacity-60">
                  {aiBusy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
              ) : (
                <button type="button" disabled={Boolean(aiBusy)} onClick={connectCodex} className="rounded-lg bg-ari-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-ari-violet-700 disabled:opacity-60">
                  {aiBusy === "connect" ? "Waiting for sign-in…" : "Connect Codex"}
                </button>
              )}
            </div>

            <div>
              <label htmlFor="codex-model" className="mb-1.5 block text-sm font-medium text-ari-text">Model mode</label>
              <select
                id="codex-model"
                value={ai.model}
                disabled={Boolean(aiBusy)}
                onChange={(event) => setAI({ model: event.target.value as DesktopAIStatus["model"] })}
                className="w-full rounded-lg border border-ari-border bg-white px-3 py-2.5 text-sm text-ari-text outline-none focus:border-ari-violet-500 focus:ring-2 focus:ring-ari-violet-100"
              >
                <option value="auto">Auto — chooses the best model for each task</option>
                <option value="sol">Sol — complex, open-ended work</option>
                <option value="terra">Terra — everyday work and faster responses</option>
                <option value="luna">Luna — repeatable, high-volume tasks</option>
              </select>
              <p className="mt-1.5 text-xs leading-5 text-ari-muted">Auto is recommended. Codex can use a faster model for simple work and a stronger model when a request needs deeper reasoning.</p>
            </div>
            {aiError && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{aiError}</div>}
          </div>
        )}
      </Card>

      {desktopAvailable && (
        <Card title="Flowtype">
          {!dictation ? <SkeletonCard /> : (
            <div className="space-y-4">
              <div className="flex flex-col gap-3 rounded-xl border border-ari-border bg-[#fcfbfd] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-ari-text">Speak naturally. Get polished text.</div>
                  <div className="mt-1 text-xs leading-5 text-ari-muted">Flowtype transcribes your voice and improves grammar and formatting without changing your meaning or tone.</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={dictation.enabled}
                  disabled={dictationBusy || !dictation.available}
                  onClick={() => toggleDictation(!dictation.enabled)}
                  className={`shrink-0 rounded-lg px-4 py-2.5 text-sm font-semibold ${dictation.enabled ? "bg-ari-violet-600 text-white" : "border border-ari-border bg-white text-ari-text"} disabled:opacity-60`}
                >
                  {dictation.enabled ? "Enabled" : "Enable"}
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <Shortcut label="Push to talk" value={dictation.shortcuts.pushToTalk} />
                <Shortcut label="Hands-free" value={dictation.shortcuts.handsFree} />
                <Shortcut label="Paste last" value={dictation.shortcuts.pasteLast} />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-ari-muted">
                <StatusPill label="Microphone" value={dictation.microphone} />
                {dictation.platform === "darwin" && <StatusPill label="Accessibility" value={dictation.accessibility} />}
                <button type="button" disabled={dictationBusy} onClick={testMicrophone} className="rounded-lg border border-ari-border bg-white px-3 py-2 font-semibold text-ari-text hover:bg-ari-soft disabled:opacity-60">Test microphone</button>
                <button type="button" disabled={dictationBusy || !dictation.lastTranscriptAvailable} onClick={() => window.ariDesktop?.dictation.pasteLast()} className="rounded-lg border border-ari-border bg-white px-3 py-2 font-semibold text-ari-text hover:bg-ari-soft disabled:opacity-50">Paste last transcript</button>
              </div>
              <p className="text-xs leading-5 text-ari-muted">Audio is kept only while Flowtype is active or waiting to retry. Up to 10 completed transcripts are stored locally on this device.</p>
              {(dictation.error || dictationError) && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{dictation.error || dictationError}</div>}
            </div>
          )}
        </Card>
      )}

      <Card title="Account">
        <Row label="WhatsApp" value={<span className="font-mono">+{s.user_phone}</span>} />
        <Row label="Active sessions" value={s.dashboardSessions?.count || "0"} />
        {s.dashboardSessions?.latest && <Row label="Last used" value={fmtTs(s.dashboardSessions.latest)} />}
      </Card>

      <Card title="Google integrations">
        <div className="mb-4 flex flex-col gap-3 rounded-xl border border-ari-border bg-ari-soft/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-ari-text">Google Workspace</div>
            <div className="mt-1 text-xs leading-5 text-ari-muted">
              {s.google?.allConnected
                ? <>Connected{s.google.google_email ? <> as <span className="font-mono">{s.google.google_email}</span></> : ""}. All Google apps below are ready.</>
                : "Connect once to enable every Google app Ari can work with."}
            </div>
          </div>
          <button type="button" onClick={() => connectGoogle("all")} disabled={googleBusy} className="shrink-0 rounded-lg bg-ari-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-ari-violet-700 disabled:cursor-wait disabled:opacity-60">
            {googleBusy ? "Opening Google…" : (s.google?.connected || s.google?.google_email) ? "Reconnect all" : "Connect all Google apps"}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {googleApps.map((app) => {
            const connected = Boolean(s.google?.products?.[app.id]);
            return (
              <div key={app.id} className="flex items-center gap-3 rounded-xl border border-ari-border bg-white p-3.5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-ari-border bg-white"><GoogleProductIcon product={app.id} /></div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-ari-text">{app.name}</div>
                  <div className="truncate text-xs text-ari-muted">{app.description}</div>
                </div>
                <button type="button" onClick={() => connectGoogle(app.id)} disabled={googleBusy || connected} className={`rounded-lg px-3 py-2 text-xs font-semibold ${connected ? "bg-emerald-50 text-emerald-700" : "border border-ari-border bg-white text-ari-text hover:bg-ari-soft"} disabled:cursor-default`}>
                  {connected ? "Connected" : "Connect"}
                </button>
              </div>
            );
          })}
        </div>
        {googleError && <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{googleError}</div>}
      </Card>

      <Card title="Other integrations">
        <Row label="Microsoft" value={
          s.microsoft?.microsoft_email
            ? <span className="text-sm">Connected as <span className="font-mono">{s.microsoft.microsoft_email}</span></span>
            : <span className="text-sm text-txt-muted">Not connected — tell Ari: <span className="font-mono">connect outlook</span></span>
        } />
      </Card>

      <Card title="Sign out">
        <div className="text-sm text-txt-muted mb-3">Ends this dashboard session. Your WhatsApp connection is unaffected.</div>
        <form action="/api/auth/logout" method="POST">
          <button type="submit" className="rounded-lg border border-ari-border bg-white px-3 py-2 text-sm font-medium hover:bg-ari-soft">Sign out of dashboard</button>
        </form>
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card-soft p-5">
      <h2 className="font-bold text-lg mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-black/10 last:border-b-0">
      <span className="text-sm text-txt-muted">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
function Shortcut({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-ari-border bg-white p-3"><div className="text-xs text-ari-muted">{label}</div><kbd className="mt-1 block text-sm font-semibold text-ari-text">{value}</kbd></div>;
}
function StatusPill({ label, value }: { label: string; value: string }) {
  const ready = value === "granted";
  return <span className={`rounded-full px-2.5 py-1.5 ${ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{label}: {value}</span>;
}
function fmtTs(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

type GoogleProduct = "gmail" | "calendar" | "drive" | "docs" | "sheets" | "slides" | "tasks";

const googleApps = [
  { id: "gmail" as const, name: "Gmail", description: "Send email and manage labels" },
  { id: "calendar" as const, name: "Google Calendar", description: "Create and manage events" },
  { id: "drive" as const, name: "Google Drive", description: "Work with your Ari files" },
  { id: "docs" as const, name: "Google Docs", description: "Create and edit documents" },
  { id: "sheets" as const, name: "Google Sheets", description: "Read and update spreadsheets" },
  { id: "slides" as const, name: "Google Slides", description: "Create and edit presentations" },
  { id: "tasks" as const, name: "Google Tasks", description: "Plan and complete tasks" },
];
