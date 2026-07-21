"use client";

// Notes & KB — demo-styled. Tabs across Notes / Reading / Knowledge.
// Search box uses dash-input style. Each list lives in dash-card-hero.
import { useEffect, useState } from "react";
import { Tabs, EmptyState } from "@/components/dash-page";

type Note = { id: number; topic: string | null; content: string; source: string | null };
type Reading = { id: number; url: string; title: string | null; summary: string | null; category: string | null; status: string | null };
type Kb = { id: number; title: string; content: string; category: string | null; tags: string | null; created_by_name: string | null };

type TabKey = "notes" | "reading" | "kb";

export function NotesContent() {
  const [tab, setTab] = useState<TabKey>("notes");
  const [q, setQ] = useState("");
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [reading, setReading] = useState<Reading[] | null>(null);
  const [kb, setKb] = useState<Kb[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const url = q.trim() ? `/api/notes/list?q=${encodeURIComponent(q.trim())}` : "/api/notes/list";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as { notes: Note[]; reading: Reading[]; kb: Kb[] };
        if (cancelled) return;
        setNotes(d.notes); setReading(d.reading); setKb(d.kb); setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <Tabs<TabKey>
          value={tab}
          onChange={setTab}
          options={[
            { value: "notes",   label: "Notes",          count: notes?.length },
            { value: "reading", label: "Reading list",   count: reading?.length },
            { value: "kb",      label: "Knowledge base", count: kb?.length },
          ]}
        />
      </div>

      <div className="mb-5">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search across all sources…"
          className="dash-input w-full"
        />
      </div>

      {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm mb-4">⚠️ {error}</div>}

      {tab === "notes"   && <NotesList   data={notes} />}
      {tab === "reading" && <ReadingList data={reading} />}
      {tab === "kb"      && <KbList      data={kb} />}
    </div>
  );
}

function NotesList({ data }: { data: Note[] | null }) {
  if (data === null) return <Loading />;
  if (data.length === 0)
    return <EmptyState icon="📝" title="No notes yet" body={<>Tell Ari: <span className="font-mono">note: launch idea — sales-led growth</span></>} />;
  return (
    <ul className="grid md:grid-cols-2 gap-3">
      {data.map(n => (
        <li key={n.id} className="dash-card p-4">
          {n.topic && <div className="dash-label mb-1.5">{n.topic}</div>}
          <div className="text-[13px] whitespace-pre-wrap break-words leading-relaxed text-[#404040]">
            {n.content}
          </div>
          {n.source && <div className="text-[11px] text-[#a3a3a3] mt-2">via {n.source}</div>}
        </li>
      ))}
    </ul>
  );
}

function ReadingList({ data }: { data: Reading[] | null }) {
  if (data === null) return <Loading />;
  if (data.length === 0)
    return <EmptyState icon="📖" title="Reading list empty" body={<>Send Ari a URL: <span className="font-mono">add to reading list &lt;url&gt;</span></>} />;
  return (
    <section className="dash-card-hero overflow-hidden">
      <ul>
        {data.map((r, i, arr) => (
          <li
            key={r.id}
            className={`flex items-center gap-4 px-6 py-4 hover:bg-[#FBFAFE] transition-colors ${
              i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#8A65FF] flex-shrink-0" />
            <a
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="text-[13.5px] font-medium underline-offset-2 hover:underline truncate flex-1 text-[#0a0a0a]"
            >
              {r.title || r.url}
            </a>
            {r.status && (
              <span className="text-[10px] uppercase tracking-wider font-medium text-[#737373] dash-pill flex-shrink-0">{r.status}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function KbList({ data }: { data: Kb[] | null }) {
  if (data === null) return <Loading />;
  if (data.length === 0)
    return <EmptyState icon="📘" title="Knowledge base empty" body={<>Tell Ari: <span className="font-mono">add KB: how to deploy → instructions…</span></>} />;
  return (
    <ul className="space-y-3">
      {data.map(k => (
        <li key={k.id} className="dash-card p-5">
          <div className="text-[15px] font-semibold">{k.title}</div>
          <div className="text-[11px] text-[#737373] mt-0.5">
            {k.category && <span>{k.category}</span>}
            {k.tags && <> · {k.tags}</>}
            {k.created_by_name && <> · {k.created_by_name}</>}
          </div>
          <div className="text-[13px] whitespace-pre-wrap break-words mt-2 line-clamp-4 leading-relaxed text-[#404040]">{k.content}</div>
        </li>
      ))}
    </ul>
  );
}

function Loading() {
  return <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading…</div>;
}
