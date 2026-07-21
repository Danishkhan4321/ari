"use client";
// Subscribe to the user-scoped /api/events invalidation stream and call
// onChange (debounced) whenever the agent mutates one of the entities this
// page displays. Fixes "Ari changed it but my open page still shows the old
// data" (smoke-test C-2) without per-page polling.
//
// Usage:
//   useEntityEvents(["contacts", "crm"], loadContacts);
import { useEffect, useRef } from "react";

const DEBOUNCE_MS = 400;

export function useEntityEvents(entities: string[], onChange: () => void) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const entitiesKey = entities.join(",");

  useEffect(() => {
    const watched = new Set(entitiesKey.split(",").filter(Boolean));
    if (watched.size === 0) return;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingWhileHidden = false;

    const fire = () => {
      // A hidden tab defers the refetch until the user comes back — no point
      // re-rendering a page nobody is looking at.
      if (document.visibilityState !== "visible") {
        pendingWhileHidden = true;
        return;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => onChangeRef.current(), DEBOUNCE_MS);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && pendingWhileHidden) {
        pendingWhileHidden = false;
        fire();
      }
    };

    const source = new EventSource("/api/events");
    const onEvent = (event: MessageEvent) => {
      try {
        const row = JSON.parse(event.data) as { entities?: string[] };
        if ((row.entities || []).some((entity) => watched.has(entity))) fire();
      } catch {
        // Malformed frame — ignore; the next event still triggers a refetch.
      }
    };
    source.addEventListener("entity.changed", onEvent);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      source.removeEventListener("entity.changed", onEvent);
      source.close();
      document.removeEventListener("visibilitychange", onVisible);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [entitiesKey]);
}
