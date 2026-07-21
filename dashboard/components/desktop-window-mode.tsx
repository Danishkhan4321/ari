"use client";

import { useEffect, useState } from "react";

export function DesktopWindowMode() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    if (!("ariDesktop" in window)) return;
    setIsDesktop(true);
    document.documentElement.dataset.ariDesktop = "true";
    return () => {
      delete document.documentElement.dataset.ariDesktop;
    };
  }, []);

  if (!isDesktop) return null;

  return (
    <nav className="ari-desktop-toolbar" aria-label="Desktop navigation">
      <ToolbarButton label="Toggle sidebar" onClick={() => window.dispatchEvent(new Event("ari:toggle-sidebar"))}><PanelIcon /></ToolbarButton>
      <ToolbarButton label="Focus Ari" onClick={() => window.dispatchEvent(new Event("ari:focus-composer"))}><SearchIcon /></ToolbarButton>
      <ToolbarButton label="Go back" onClick={() => window.history.back()}><BackIcon /></ToolbarButton>
      <ToolbarButton label="Go forward" onClick={() => window.history.forward()}><ForwardIcon /></ToolbarButton>
    </nav>
  );
}

function ToolbarButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-label={label} onClick={onClick} className="ari-desktop-toolbar-button">{children}</button>;
}

function PanelIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="1.5" /><path d="M8 3.5v13" /></svg>; }
function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="4.5" /><path d="m12 12 4 4" /></svg>; }
function BackIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 4.5 6 10l5.5 5.5M6.5 10H17" /></svg>; }
function ForwardIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8.5 4.5 5.5 5.5-5.5 5.5M13.5 10H3" /></svg>; }
