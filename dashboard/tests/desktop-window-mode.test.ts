import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("reserves desktop chrome without adding a product logo", () => {
  const mode = read("components/desktop-window-mode.tsx");
  const layout = read("app/layout.tsx");
  const styles = read("app/globals.css");

  assert.match(mode, /"ariDesktop" in window/);
  assert.match(layout, /<DesktopWindowMode/);
  assert.match(styles, /html\[data-ari-desktop="true"\] body::before/);
  assert.match(styles, /-webkit-app-region: drag/);
  assert.match(mode, /ari-desktop-toolbar/);
  assert.match(mode, /ari:toggle-sidebar/);
  assert.match(mode, /window\.history\.back/);
  assert.doesNotMatch(mode, /Toggle navigation|function MenuIcon/);
});
