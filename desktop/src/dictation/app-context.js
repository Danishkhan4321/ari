'use strict';

const CATEGORY_PATTERNS = [
  ['chat', /slack|teams|discord|whatsapp|telegram|signal|messages/i],
  ['email', /outlook|mail|thunderbird|spark/i],
  ['code', /visual studio code|vscode|cursor|windsurf|xcode|intellij|webstorm|pycharm|sublime|zed/i],
  ['terminal', /terminal|powershell|command prompt|cmd\.exe|iterm|warp|alacritty|wezterm|kitty/i],
  ['document', /word|pages|notion|obsidian|libreoffice|writer/i],
];

function classifyApplication(name) {
  const value = String(name || '');
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(value))?.[0] || 'generic';
}

async function defaultActiveWindow() {
  const imported = await import('active-win');
  return imported.activeWindow({ accessibilityPermission: false, screenRecordingPermission: false });
}

function createAppContext({ activeWindow = defaultActiveWindow } = {}) {
  async function current() {
    try {
      const value = await activeWindow();
      if (!value) return null;
      return {
        id: String(value.id ?? ''),
        processId: Number(value.owner?.processId) || null,
        category: classifyApplication(value.owner?.name),
      };
    } catch (_) {
      return null;
    }
  }

  function same(left, right) {
    if (!left || !right) return false;
    if (left.id && right.id) return left.id === right.id;
    return Boolean(left.processId && right.processId && left.processId === right.processId);
  }

  return { current, same };
}

module.exports = { CATEGORY_PATTERNS, classifyApplication, createAppContext, defaultActiveWindow };
