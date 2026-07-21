'use strict';

function snapshotClipboard(clipboard) {
  const image = clipboard.readImage();
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    bookmark: clipboard.readBookmark(),
    image: image?.isEmpty?.() ? undefined : image,
  };
}

function restoreClipboard(clipboard, snapshot) {
  const data = {};
  if (snapshot.text) data.text = snapshot.text;
  if (snapshot.html) data.html = snapshot.html;
  if (snapshot.rtf) data.rtf = snapshot.rtf;
  if (snapshot.image) data.image = snapshot.image;
  if (snapshot.bookmark?.url) data.bookmark = snapshot.bookmark.url;
  clipboard.clear();
  if (Object.keys(data).length) clipboard.write(data);
}

function createClipboardPaste({ clipboard, hook, keys, platform = process.platform, restoreDelayMs = 900 } = {}) {
  if (!clipboard || !hook || !keys) throw new TypeError('clipboard, hook, and keys are required');

  async function paste(text, { restore = true } = {}) {
    const value = String(text || '');
    if (!value) return false;
    const previous = restore ? snapshotClipboard(clipboard) : null;
    clipboard.writeText(value);
    hook.keyTap(keys.V, [platform === 'darwin' ? keys.Meta : keys.Ctrl]);
    if (previous) {
      const timer = setTimeout(() => restoreClipboard(clipboard, previous), restoreDelayMs);
      timer.unref?.();
    }
    return true;
  }

  function copy(text) {
    const value = String(text || '');
    if (!value) return false;
    clipboard.writeText(value);
    return true;
  }

  return { copy, paste, restoreClipboard: (snapshot) => restoreClipboard(clipboard, snapshot), snapshotClipboard: () => snapshotClipboard(clipboard) };
}

module.exports = { createClipboardPaste, restoreClipboard, snapshotClipboard };
