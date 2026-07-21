"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export type RecentChatItem = {
  id: string;
  title: string | null;
  isLegacy: boolean;
  createdAt: string;
  updatedAt: string;
};

type AriDesktopWindow = Window & {
  ariDesktop?: {
    debug?: {
      showSessionContextMenu: (sessionId: string) => Promise<boolean>;
    };
  };
};

function showSessionContextMenu(event: React.MouseEvent, sessionId: string) {
  const debugBridge = (window as AriDesktopWindow).ariDesktop?.debug;
  if (!debugBridge) return;
  event.preventDefault();
  void debugBridge.showSessionContextMenu(sessionId);
}

export function SidebarRecentChats({ className = "" }: { className?: string }) {
  const [items, setItems] = useState<RecentChatItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/chat/sessions", { cache: "no-store" });
        if (!response.ok) return;
        const sessions = ((await response.json()) as { sessions?: RecentChatItem[] }).sessions ?? [];
        if (cancelled) return;
        setItems(sessions.slice(0, 8));
      } catch {
        // Recent sessions are helpful context, but never block the workspace.
      }
    };

    void load();
    const interval = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return <RecentChatsList items={items} className={className} />;
}

export function RecentChatsList({
  items,
  onSelect,
  onRename,
  className = "",
}: {
  items: RecentChatItem[];
  onSelect?: (sessionId: string) => void;
  onRename?: (sessionId: string) => void;
  className?: string;
}) {
  return (
    <section aria-label="Recent sessions" className={className}>
      <div className="px-2.5 pb-2.5 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] text-ari-muted">Recent sessions</div>
      {items.length === 0 ? (
        <p className="px-2.5 py-1 text-[12px] font-normal leading-relaxed text-[#8a847d]">Your recent sessions will appear here.</p>
      ) : (
        <div className="space-y-1">
          {items.map((item) =>
            onSelect ? (
              <button
                type="button"
                key={item.id}
                onClick={() => onSelect(item.id)}
                onDoubleClick={() => onRename?.(item.id)}
                onContextMenu={(event) => showSessionContextMenu(event, item.id)}
                className="block h-8 w-full truncate rounded-[7px] px-2.5 text-left text-[12px] font-normal text-[#716b64] transition hover:bg-ari-nav-active hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"
                title={item.title || "New session"}
              >
                {item.title || "New session"}
              </button>
            ) : (
              <Link
                key={item.id}
                href={`/chat?session=${encodeURIComponent(item.id)}`}
                onContextMenu={(event) => showSessionContextMenu(event, item.id)}
                className="block h-8 w-full truncate rounded-[7px] px-2.5 text-[12px] font-normal leading-8 text-[#716b64] transition hover:bg-ari-nav-active hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"
                title={item.title || "New session"}
              >
                {item.title || "New session"}
              </Link>
            ),
          )}
        </div>
      )}
    </section>
  );
}
