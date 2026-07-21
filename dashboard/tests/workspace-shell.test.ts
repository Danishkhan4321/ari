import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the signed-in shell uses the shared workspace side navigation", () => {
  const shell = read("components/shell.tsx");
  assert.match(shell, /WorkspaceHeader/);
  assert.match(shell, /WorkspaceSidebar/);
  assert.match(shell, /ari-workspace-shell/);
  assert.match(shell, /ari-product-frame/);
  assert.match(shell, /bg-ari-product-canvas/);
  assert.match(shell, /h-screen overflow-hidden/);
  assert.match(shell, /overflow-y-auto/);
  assert.doesNotMatch(shell, /<aside/);
  assert.doesNotMatch(shell, /<Sidebar(?:\s|\/|>)|from ["']\.\/sidebar["']/);
});

test("the shared sidebar matches the approved warm Ari navigation", () => {
  const sidebar = read("components/workspace-sidebar.tsx");
  const recent = read("components/recent-chats.tsx");

  assert.doesNotMatch(sidebar, /onToggle\?: \(\) => void/);
  assert.doesNotMatch(sidebar, /Collapse sidebar|Expand sidebar|AriLogo/);
  assert.match(sidebar, /bg-ari-nav/);
  assert.match(sidebar, /bg-ari-nav-active/);
  assert.match(sidebar, /text-ari-ink/);
  assert.match(sidebar, />New session</);
  assert.match(sidebar, />Settings</);
  assert.match(sidebar, /Personal workspace/);
  assert.match(sidebar, /w-\[264px\]/);
  assert.match(sidebar, /rounded-\[16px\]/);
  assert.match(sidebar, /text-\[13px\]/);
  assert.match(sidebar, /text-black/);
  assert.match(read("components/icons.tsx"), /case "notes":\s+return <FlowtypeIcon/);
  assert.match(read("components/icons.tsx"), /case "contacts":\s+return <CrmIcon/);
  assert.match(read("components/icons.tsx"), /case "team":\s+return <TeamIcon/);
  assert.match(recent, />Recent sessions</);
  assert.doesNotMatch(sidebar, /#5f34c4|#f8f8fa|#28222f/);
});

test("the shared shell uses the approved inset desktop workspace frame", () => {
  const shell = read("components/shell.tsx");
  const styles = read("app/globals.css");

  assert.match(shell, /ari-workspace-main/);
  assert.match(shell, /rounded-\[18px\]/);
  assert.match(styles, /\.ari-product-frame[\s\S]*gap:\s*12px/);
  assert.match(styles, /html\[data-ari-desktop="true"\] \.ari-product-canvas[\s\S]*padding:\s*10px 12px 12px/);
  assert.match(styles, /\.ari-chat-main[\s\S]*border-radius:\s*18px/);
});

test("the shared workspace side navigation exposes every primary business tool", () => {
  const header = read("components/workspace-tool-nav.tsx");
  for (const route of ["/chat", "/tasks", "/contacts", "/inbox", "/meetings", "/team", "/reminders"]) {
    assert.match(header, new RegExp(`href:\\s*\"${route}\"`), route);
  }
  assert.doesNotMatch(header, /href:\s*"\/messages"/);
  assert.match(header, /export const PRIMARY_TOOLS/);
  assert.match(header, /label: "Home"/);
  assert.match(header, /label: "CRM"/);
  assert.match(header, /export const PERSONAL_TOOLS/);
  assert.match(header, /Personal workspace/);
  assert.match(header, /label: "Scheduled emails"/);
  assert.match(header, /aria-expanded=/);
  assert.match(header, /usePathname/);
  assert.match(header, /aria-label="Workspace tools"/);
  assert.match(header, /orientation = "vertical"/);
  assert.match(header, /data-group="personal-workspace"/);
  assert.match(header, /className="pt-px"/);
  assert.match(header, /border border-ari-border bg-white text-ari-text/);
  assert.doesNotMatch(header, /bg-ari-soft text-ari-violet-700|bg-ari-violet-500/);
});

test("settings lives inside the clickable profile menu instead of the top header", () => {
  const header = read("components/workspace-header.tsx");
  const sidebar = read("components/workspace-sidebar.tsx");

  assert.doesNotMatch(header, /href="\/settings"|aria-label="Settings"/);
  assert.match(sidebar, /aria-haspopup="menu"/);
  assert.match(sidebar, /role="menu" aria-label="Profile menu"/);
  assert.match(sidebar, /role="menuitem"/);
  assert.match(sidebar, /href="\/settings"/);
  assert.match(sidebar, />Settings</);
});

test("the retired messages page hands old links to Team Chat", () => {
  const page = read("app/messages/page.tsx");
  assert.match(page, /redirect\("\/team#tab=chat"\)/);
  assert.doesNotMatch(page, /<MessagesContent|<Shell/);
});

test("chat and every signed-in screen use the same shared workspace sidebar", () => {
  const shell = read("components/shell.tsx");
  const chat = read("app/chat/chat-client.tsx");

  assert.match(shell, /<WorkspaceSidebar/);
  assert.match(chat, /<WorkspaceSidebar/);
  assert.match(shell, /from ["']\.\/workspace-sidebar["']/);
  assert.match(chat, /from ["']@\/components\/workspace-sidebar["']/);
  assert.match(chat, /ari:toggle-sidebar/);
  assert.doesNotMatch(chat, /function HomeRail/);
  assert.match(chat, /ari-chat-panel-header/);
});
