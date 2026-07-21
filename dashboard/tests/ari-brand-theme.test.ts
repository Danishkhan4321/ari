import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const visibleSurfacePaths = ["app", "components"].flatMap((root) =>
  readdirSync(new URL(`../${root}`, import.meta.url), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".tsx"))
    .map((path) => `${root}/${path.replaceAll("\\", "/")}`),
);

test("defines the complete Ari light-theme token set", () => {
  const css = read("app/globals.css");
  for (const token of [
    "--ari-product-canvas",
    "--ari-nav",
    "--ari-nav-active",
    "--ari-ink",
    "--ari-accent",
    "--ari-focus",
    "--ari-success",
    "--ari-danger",
    "--ari-surface",
    "--ari-canvas",
    "--ari-surface-subtle",
    "--ari-accent-soft",
    "--ari-border",
    "--ari-border-strong",
    "--ari-text",
    "--ari-text-muted",
    "--ari-violet-700",
    "--ari-violet-600",
    "--ari-violet-500",
    "--ari-violet-400",
    "--ari-lavender",
    "--ari-midnight",
  ]) {
    assert.match(css, new RegExp(`${token}:`));
  }
});

test("defines the approved warm product token values", () => {
  const css = read("app/globals.css");
  for (const [token, value] of [
    ["--ari-product-canvas", "#e8e9ec"],
    ["--ari-nav", "#fffdf3"],
    ["--ari-nav-active", "#f4f0cf"],
    ["--ari-ink", "#0a0a0a"],
    ["--ari-accent", "#f7dd2a"],
    ["--ari-border", "#dfddda"],
    ["--ari-text", "#141414"],
    ["--ari-text-muted", "#706965"],
  ]) {
    assert.match(css, new RegExp(`${token}:\\s*${value}`, "i"), token);
  }
});

test("shared page primitives use the approved light professional hierarchy", () => {
  const css = read("app/globals.css");
  const page = read("components/dash-page.tsx");

  assert.match(css, /\.dash-h1\s*\{[^}]*font-semibold/);
  assert.match(css, /\.dash-h2\s*\{[^}]*font-medium/);
  assert.match(css, /\.dash-label\s*\{[^}]*font-medium/);
  assert.match(css, /\.dash-btn-primary\s*\{[^}]*bg-ari-ink/);
  assert.match(css, /\.dash-tab-active\s*\{[^}]*bg-ari-nav-active[^}]*text-ari-ink/);
  assert.match(page, /max-w-\[1180px\][\s\S]*mx-auto/);
  assert.doesNotMatch(page, /badge\?\.label \?\? "Workspace"/);
  assert.doesNotMatch(page, /sticky top-0/);
});

test("uses Ari identity on all visible entry surfaces", () => {
  for (const path of [
    "components/sidebar.tsx",
    "components/icons.tsx",
    "app/login/page.tsx",
    "app/get-started/page.tsx",
    "app/onboarding/page.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /logo-wolf|WolfIcon/i, path);
  }
});

test("removes the legacy decorative palette from shared UI", () => {
  const source = [
    "app/globals.css",
    "components/sidebar.tsx",
    "components/shell.tsx",
    "components/dash-page.tsx",
    "components/kpi-strip.tsx",
  ]
    .map(read)
    .join("\n");

  assert.doesNotMatch(
    source,
    /#(?:F2F5F2|7DFFB3|818CF8|4ADBC8|FD693F|F2A3D8|7BD3F7|9BE7BF|FFE38C|FF9D6E|fbfaf3|e8e6dc)/i,
  );
});

test("keeps every visible dashboard surface on the Ari brand system", () => {
  const legacyPalette =
    /#(?:F2F5F2|FCFDFF|DAF464|7DFFB3|818CF8|4ADBC8|FD693F|F2A3D8|1C221B|7BD3F7|9BE7BF|FFE38C|FF9D6E|fbfaf3|e8e6dc|efece2)/i;

  for (const path of visibleSurfacePaths) {
    const source = read(path);
    assert.doesNotMatch(source, /logo-wolf|WolfIcon/i, path);
    assert.doesNotMatch(source, legacyPalette, path);
  }
});
