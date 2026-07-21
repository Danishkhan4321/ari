"use client";

import { useEffect, useState } from "react";
import { identify } from "@/lib/analytics";
import { CommandPalette } from "./command-palette";
import { WorkspaceHeader } from "./workspace-header";
import { WorkspaceSidebar } from "./workspace-sidebar";

export function Shell({ userPhone, children, showHeader = true }: { userPhone: string; children: React.ReactNode; showHeader?: boolean }) {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isToggle = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (isToggle) {
        event.preventDefault();
        setCmdkOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const toggleSidebar = () => setSidebarVisible((visible) => !visible);
    window.addEventListener("ari:toggle-sidebar", toggleSidebar);
    return () => window.removeEventListener("ari:toggle-sidebar", toggleSidebar);
  }, []);

  useEffect(() => {
    if (userPhone) void identify(userPhone);
  }, [userPhone]);

  return (
    <div className="ari-product-canvas flex h-screen overflow-hidden bg-ari-product-canvas text-ari-text">
      <div className="ari-product-frame ari-workspace-shell dash flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <WorkspaceSidebar userPhone={userPhone} expanded={sidebarVisible} />
        <div className="ari-workspace-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[18px] border border-ari-border bg-white shadow-[0_1px_2px_rgba(38,8,5,0.025)]">
          {showHeader ? (
            <WorkspaceHeader onOpenSearch={() => setCmdkOpen(true)} sidebarPresent />
          ) : (
            <div className="md:hidden"><WorkspaceHeader sidebarPresent /></div>
          )}
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
    </div>
  );
}
