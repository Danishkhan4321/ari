"use client";

import { useEffect, useState } from "react";

type TranscriptItem = {
  id: string;
  text: string;
  createdAt: string;
  pasted: boolean;
};

type DictationHistoryBridge = {
  listRecent: () => Promise<{ ok: boolean; items: TranscriptItem[] }>;
  copyRecent: (transcriptId: string) => Promise<{ ok: boolean }>;
};

type DesktopWindow = Window & { ariDesktop?: { dictation?: DictationHistoryBridge } };

export function TranscriptionsContent() {
  const [items, setItems] = useState<TranscriptItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = (window as DesktopWindow).ariDesktop?.dictation;
    if (!bridge) {
      setItems([]);
      setError("Flowtype history is available in the Ari desktop app.");
      return;
    }
    bridge.listRecent()
      .then((result) => setItems(result.ok ? result.items.slice(0, 10) : []))
      .catch((reason) => {
        setItems([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  async function copy(item: TranscriptItem) {
    const bridge = (window as DesktopWindow).ariDesktop?.dictation;
    if (!bridge) return;
    setError(null);
    try {
      const result = await bridge.copyRecent(item.id);
      if (!result.ok) throw new Error("The Flowtype transcript could not be copied.");
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((current) => current === item.id ? null : current), 1600);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (items === null) {
    return <div className="card-soft p-5 text-sm text-ari-muted">Loading Flowtype history…</div>;
  }

  if (!items.length) {
    return (
      <div className="card-soft p-8 text-center">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl bg-[#f1e9f4] text-[#754786]"><WaveIcon /></div>
        <h2 className="mt-4 text-base font-semibold text-ari-text">No Flowtype transcripts yet</h2>
        <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-ari-muted">{error || "Use Flowtype from the composer or its keyboard shortcut. Your completed text will appear here automatically."}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {items.map((item) => {
        const open = openId === item.id;
        return (
          <article key={item.id} className="card-soft overflow-hidden">
            <div className="flex items-start gap-4 p-4 sm:p-5">
              <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#f1e9f4] text-[#754786]"><WaveIcon /></div>
              <button type="button" onClick={() => setOpenId(open ? null : item.id)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">
                <span className="flex flex-wrap items-center gap-2">
                  <time className="text-xs font-medium text-ari-muted" dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${item.pasted ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                    {item.pasted ? "Pasted" : "Saved for recovery"}
                  </span>
                </span>
                <span className={`mt-1.5 block text-sm leading-6 text-ari-text ${open ? "whitespace-pre-wrap" : "line-clamp-2"}`}>{item.text}</span>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => setOpenId(open ? null : item.id)} className="rounded-lg border border-ari-border bg-white px-3 py-2 text-xs font-semibold text-ari-text hover:bg-ari-soft">
                  {open ? "Close" : "Open"}
                </button>
                <button type="button" onClick={() => copy(item)} className="rounded-lg bg-ari-violet-600 px-3 py-2 text-xs font-semibold text-white hover:bg-ari-violet-700">
                  {copiedId === item.id ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </article>
        );
      })}
      <p className="px-1 text-xs leading-5 text-ari-muted">Stored only on this device. Flowtype keeps a maximum of 10 transcripts and does not retain their audio after completion.</p>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function WaveIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M3 7v4M6 5v8M9 3v12M12 5v8M15 7v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
