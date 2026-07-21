import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("chat uses the immersive Ari workspace instead of the legacy dashboard shell", () => {
  const page = read("app/chat/page.tsx");
  const chat = read("app/chat/chat-client.tsx");
  const sidebar = read("components/workspace-sidebar.tsx");
  const recentChats = read("components/recent-chats.tsx");

  assert.doesNotMatch(page, /<Shell|font-serif|Same conversation as your WhatsApp/);
  assert.doesNotMatch(chat, /WorkspaceHeader/);
  assert.match(chat, /WorkspaceSidebar/);
  assert.match(sidebar, /New session/);
  assert.doesNotMatch(chat, /New task|Recent work|Team operating system|>Ready</);
  assert.doesNotMatch(sidebar, /ProfileMenu/);
  assert.match(chat, /What should we work on today\?/);
  assert.match(chat, /ari-chat-shell/);
  assert.match(sidebar, /ari-home-rail/);
  assert.match(chat, /HomeWelcome/);
  assert.match(chat, /ari-chat-panel-header/);
  assert.match(chat, /ari-chat-composer/);
  assert.match(chat, /selectedSession\?\.title/);
  assert.match(chat, /!showHome && <div className="ari-chat-panel-header/);
  assert.match(chat, /max-w-\[1080px\]/);
  assert.match(chat, /max-w-\[72%\]/);
  assert.match(chat, /taskStatusLines\(prompt\)/);
  assert.match(chat, /AriActivityIcon/);
  assert.match(chat, /<span>Working<\/span>/);
  assert.doesNotMatch(chat, /Working for|fmtTime|formatElapsed|useElapsedSeconds/);
  assert.match(chat, /LiveSignal/);
  assert.match(chat, /ChevronIcon/);
  assert.match(chat, /onStop=\{stopActiveRun\}/);
  assert.match(chat, /ari:focus-composer/);
  assert.match(chat, /conversationTitle/);
  assert.match(chat, /\/api\/chat\/sessions/);
  assert.match(chat, /clientMessageId/);
  assert.match(chat, /submittingRef\.current/);
  assert.doesNotMatch(chat, /groupMessagesIntoSessions|setSessionBounds/);
  assert.match(chat, /Rename session/);
  assert.match(chat, /onRenameSession=\{openRenameChat\}/);
  assert.match(chat, /\/api\/chat\/stop/);
  assert.match(chat, /aria-label="Stop task"/);
  assert.match(chat, /AttachmentCard/);
  assert.match(chat, /FilePreviewDialog/);
  assert.match(recentChats, /onContextMenu/);
  assert.match(recentChats, /showSessionContextMenu/);
  assert.doesNotMatch(chat, /ToolSparkIcon|Understanding your request|Ari is working|Live activity/);
});

test("chat uses the restrained Ari light workspace system", () => {
  const styles = read("app/globals.css");

  assert.match(styles, /\.ari-chat-shell/);
  assert.match(styles, /\.ari-chat-sidebar/);
  assert.match(styles, /\.ari-message-assistant/);
  assert.match(styles, /\.ari-chat-sidebar[\s\S]*background:\s*#ffffff/);
  assert.match(styles, /\.ari-chat-sidebar-panel[\s\S]*border:\s*1px solid var\(--ari-border\)/);
  assert.match(styles, /\.ari-chat-sidebar-panel[\s\S]*border-radius:\s*16px/);
  assert.match(styles, /\.ari-chat-main[\s\S]*background:\s*#ffffff/);
  assert.match(styles, /\.ari-chat-main[\s\S]*border-radius:\s*0/);
  assert.match(styles, /\.ari-chat-frame[\s\S]*background:\s*transparent/);
  assert.match(styles, /\.ari-activity-glyph/);
  assert.match(styles, /\.ari-agent-progress/);
  assert.match(styles, /ari-live-sweep/);
  assert.doesNotMatch(styles, /\.ari-chat-shell[\s\S]{0,220}(?:linear|radial)-gradient/);
});

test("chat home and reasoning states use Ari yellow without legacy purple accents", () => {
  const chat = read("app/chat/chat-client.tsx");
  const styles = read("app/globals.css");

  assert.match(chat, /ari-home-mark/);
  assert.match(chat, /Review CRM and follow-ups/);
  assert.match(chat, /Create an email campaign/);
  assert.match(chat, /Summarize a meeting/);
  assert.match(chat, /Plan team priorities/);
  assert.match(styles, /\.ari-home-mark[\s\S]*rgba\(222, 197, 31/);
  assert.match(styles, /\.ari-live-dot[\s\S]*var\(--ari-accent\)/);
  assert.match(styles, /\.ari-chat-composer:focus-within[\s\S]*var\(--ari-accent-strong\)/);
  assert.match(styles, /\.ari-chat-send[\s\S]*var\(--ari-accent\)/);
  assert.doesNotMatch(chat, /#8e3ff0|#9d82e8/i);
  assert.doesNotMatch(styles, /#c774ff|#8c35dc|#5b1d98|#7651dc|#d6c8f7|#a98fe8|#6742dc|#5733cf/i);
});

test("chat uses the compact composer with functional desktop voice input", () => {
  const chat = read("app/chat/chat-client.tsx");

  assert.doesNotMatch(chat, /ari-chat-context-bar/);
  assert.doesNotMatch(chat, />Personal workspace</);
  assert.doesNotMatch(chat, />Session ready</);
  assert.doesNotMatch(chat, />Connected tools</);
  assert.match(chat, /aria-label=.*"Start Flowtype"/);
  assert.match(chat, /aria-pressed=/);
  assert.match(chat, /ariDesktop\?\.dictation/);
  assert.match(chat, /bridge\.start\(\)/);
  assert.match(chat, /bridge\.stop\(\)/);
  assert.match(chat, /<MicrophoneIcon/);
  assert.match(chat, /placeholder=.*"Ask Ari to do anything"/);
  assert.match(chat, /max-w-\[920px\]/);
});

test("chat exposes real business tools in the shared side navigation", () => {
  const chat = read("components/workspace-tool-nav.tsx");

  for (const route of ["/chat", "/tasks", "/contacts", "/inbox", "/meetings", "/team", "/reminders"]) {
    assert.match(chat, new RegExp(`href:\\s*\"${route}\"`), route);
  }
});

test("chat removes the old brutal and WhatsApp visual language", () => {
  const chat = read("app/chat/chat-client.tsx");

  assert.doesNotMatch(chat, /shadow-brutal|btn-brutal|border-2 border-black|WhatsApp-style|ReadReceipt/);
});

test("chat does not present an interactive composer until a session is ready", () => {
  const chat = read("app/chat/chat-client.tsx");

  assert.match(chat, /const \[sessionsLoading, setSessionsLoading\] = useState\(true\)/);
  assert.match(chat, /Retry session loading/);
  assert.match(chat, /disabled=\{sending \|\| awaitingReply \|\| sessionsLoading \|\| !selectedSessionId\}/);
  assert.match(chat, /disabled=\{sending \|\| sessionsLoading \|\| !selectedSessionId \|\| \(!input\.trim\(\) && attachments\.length === 0\)\}/);
});

test("chat composer grows with its content up to eight visible lines", () => {
  const chat = read("app/chat/chat-client.tsx");

  assert.match(chat, /useLayoutEffect/);
  assert.match(chat, /resizeComposerToContent/);
  assert.match(chat, /COMPOSER_MAX_HEIGHT_PX\s*=\s*208/);
  assert.match(chat, /overflowY\s*=\s*scrollHeight > COMPOSER_MAX_HEIGHT_PX \? "auto" : "hidden"/);
  assert.doesNotMatch(chat, /max-h-36/);
});

test("chat queues follow-up instructions and exposes steer and delete controls while a run is active", () => {
  const chat = read("app/chat/chat-client.tsx");

  assert.match(chat, /QueuedInstructionTray/);
  assert.match(chat, />↪ Steer</);
  assert.match(chat, /Delete queued instruction/);
  assert.match(chat, /Add an instruction for Ari to do next/);
  assert.match(chat, /dispatchQueuedInstruction/);
  assert.match(chat, /SESSION_RUNTIME_STORAGE_KEY/);
  assert.match(chat, /awaitingReply && !input\.trim\(\)/);
  assert.doesNotMatch(chat, /submittingRef\.current \|\| awaitingReply \|\| !selectedSessionId/);
});
