# Ari Prism Brand and Light Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace legacy desktop/dashboard branding with the approved Prism A identity and apply the refined white-first violet theme without changing features or layout.

**Architecture:** A canonical vector logo feeds committed dashboard and Electron assets. CSS variables and Tailwind aliases define semantic color roles, shared shell components consume those roles, and a bounded mechanical migration removes legacy decorative colors from route components while preserving semantic status colors.

**Tech Stack:** Electron 43, electron-builder 26, Next.js 14, React 18, Tailwind CSS 3, TypeScript 5.6, Node test runner, Python/Pillow for deterministic icon export.

---

## File map

### New files

- `dashboard/public/ari-mark.svg` — transparent Prism A mark for UI containers.
- `dashboard/public/ari-wordmark.svg` — Prism A plus Ari wordmark lockup.
- `dashboard/public/ari-icon.svg` — midnight-tile desktop/browser source icon.
- `dashboard/public/ari-mark-monochrome.svg` — single-color fallback mark.
- `dashboard/public/ari-icon.png` — 1024 px packaging/store source.
- `dashboard/public/favicon.ico` — multi-size browser favicon, replacing the malformed legacy file.
- `desktop/build/icon.png` — Electron PNG source.
- `desktop/build/icon.ico` — Windows multi-resolution icon.
- `desktop/build/icon.icns` — macOS multi-resolution icon.
- `scripts/generate-ari-brand-assets.py` — deterministic icon exporter.
- `dashboard/tests/ari-brand-theme.test.ts` — dashboard brand/theme regression audit.
- `desktop/tests/branding.test.js` — Electron asset/config regression tests.

### Core files modified

- `dashboard/app/globals.css` — semantic Ari variables and shared component states.
- `dashboard/tailwind.config.ts` — Ari aliases and legacy class compatibility mapped to the approved palette.
- `dashboard/app/layout.tsx` — Ari metadata and local favicon declaration.
- `dashboard/package.json`, `dashboard/package-lock.json` — rename package to `ari-dashboard`.
- `dashboard/components/icons.tsx` — replace `WolfIcon` with `AriMark`.
- `dashboard/components/sidebar.tsx` — Prism identity and refined violet active/hover states.
- `dashboard/components/shell.tsx` — white-first page canvas.
- `dashboard/components/dash-page.tsx` — shared topbar, tabs, fields, empty states, and local-only footer.
- `dashboard/components/kpi-strip.tsx` — violet KPI hierarchy.
- `dashboard/components/command-palette.tsx`, `dashboard/components/crm-subnav.tsx`, `dashboard/components/import-csv-modal.tsx` — shared interaction colors.
- `dashboard/app/login/page.tsx`, `dashboard/app/get-started/page.tsx`, `dashboard/app/auth/page.tsx`, `dashboard/app/onboarding/page.tsx`, `dashboard/app/onboarding/onboarding-form.tsx` — Prism identity and removal of visible hosted-product links.
- `desktop/package.json` — packaged icon paths.
- `desktop/src/startup.html` — white-first violet startup treatment.

### Route files mechanically recolored

- `dashboard/app/chat/chat-client.tsx`
- `dashboard/app/contacts/groups/[id]/email/composer.tsx`
- `dashboard/app/contacts/groups/[id]/group-detail.tsx`
- `dashboard/app/contacts/groups/page.tsx`
- `dashboard/app/contacts/page.tsx`
- `dashboard/app/contacts/pipeline/page.tsx`
- `dashboard/app/contacts/pipeline/pipeline-board.tsx`
- `dashboard/app/home-agenda.tsx`
- `dashboard/app/home-hero.tsx`
- `dashboard/app/inbox/inbox-content.tsx`
- `dashboard/app/meetings/meetings-content.tsx`
- `dashboard/app/messages/messages-content.tsx`
- `dashboard/app/messages/page.tsx`
- `dashboard/app/notes/notes-content.tsx`
- `dashboard/app/p/[slug]/page.tsx`
- `dashboard/app/productivity/page.tsx`
- `dashboard/app/productivity/productivity-content.tsx`
- `dashboard/app/reminders/reminders-list.tsx`
- `dashboard/app/tasks/tasks-content.tsx`
- `dashboard/app/team/ai-plan-modal.tsx`
- `dashboard/app/team/boards-section.tsx`
- `dashboard/app/team/broadcasts-section.tsx`
- `dashboard/app/team/bulk-invite-modal.tsx`
- `dashboard/app/team/calendar-section.tsx`
- `dashboard/app/team/hashtags-widget.tsx`
- `dashboard/app/team/page.tsx`
- `dashboard/app/team/pending-widget.tsx`
- `dashboard/app/team/settings-section.tsx`
- `dashboard/app/team/setup-checklist.tsx`
- `dashboard/app/team/sprints-section.tsx`
- `dashboard/app/team/team-content.tsx`
- `dashboard/app/team/team-task-modal.tsx`
- `dashboard/lib/crm-shared.ts`
- `dashboard/lib/format.ts`

Internal compatibility identifiers are migrated to Ari names together with their tests so the product has one identity and one local-navigation boundary.

## Task 1: Add brand and theme regression tests

**Files:**
- Create: `dashboard/tests/ari-brand-theme.test.ts`
- Create: `desktop/tests/branding.test.js`

- [ ] **Step 1: Write the dashboard audit test**

Create a Node test that reads application-owned user-interface files and enforces the approved tokens and exclusions:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("defines the complete Ari light-theme token set", () => {
  const css = read("app/globals.css");
  for (const token of [
    "--ari-surface", "--ari-canvas", "--ari-surface-subtle", "--ari-accent-soft",
    "--ari-border", "--ari-border-strong", "--ari-text", "--ari-text-muted",
    "--ari-violet-700", "--ari-violet-600", "--ari-violet-500",
    "--ari-violet-400", "--ari-lavender", "--ari-midnight",
  ]) assert.match(css, new RegExp(`${token}:`));
});

test("uses Ari identity on all visible entry surfaces", () => {
  for (const path of [
    "components/sidebar.tsx", "components/icons.tsx", "app/login/page.tsx",
    "app/get-started/page.tsx", "app/onboarding/page.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /logo-wolf|WolfIcon|https?:\/\/(?!127\.0\.0\.1|localhost)/i, path);
  }
});

test("removes the legacy decorative palette from shared UI", () => {
  const source = [
    "app/globals.css", "components/sidebar.tsx", "components/shell.tsx",
    "components/dash-page.tsx", "components/kpi-strip.tsx",
  ].map(read).join("\n");
  assert.doesNotMatch(source, /#(?:F2F5F2|7DFFB3|818CF8|4ADBC8|FD693F|F2A3D8|7BD3F7|9BE7BF|FFE38C|FF9D6E|fbfaf3|e8e6dc)/i);
});
```

- [ ] **Step 2: Write the Electron branding test**

```js
const assert = require('node:assert/strict');
const { existsSync, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const desktopRoot = path.resolve(__dirname, '..');

test('packages Ari icons for Windows and macOS', () => {
  const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.build.win.icon, 'build/icon.ico');
  assert.equal(pkg.build.mac.icon, 'build/icon.icns');
  for (const file of ['icon.png', 'icon.ico', 'icon.icns']) {
    const target = path.join(desktopRoot, 'build', file);
    assert.equal(existsSync(target), true, `${file} is missing`);
    assert.ok(statSync(target).size > 1000, `${file} is unexpectedly small`);
  }
});

test('does not package the legacy wolf asset', () => {
  const pkg = readFileSync(path.join(desktopRoot, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /logo-wolf/i);
});
```

- [ ] **Step 3: Run the focused tests and confirm they fail**

Run:

```powershell
npm test --prefix dashboard -- --test-name-pattern="Ari|identity|legacy decorative"
npm test --prefix desktop -- --test-name-pattern="Ari icons|legacy wolf"
```

Expected: failures for missing CSS variables, legacy logo references, and missing packaged icon files.

- [ ] **Step 4: Commit the failing tests locally**

```powershell
git add dashboard/tests/ari-brand-theme.test.ts desktop/tests/branding.test.js
git commit -m "test: define Ari brand and theme requirements"
```

## Task 2: Create canonical Prism assets and desktop exports

**Files:**
- Create: `dashboard/public/ari-mark.svg`
- Create: `dashboard/public/ari-wordmark.svg`
- Create: `dashboard/public/ari-icon.svg`
- Create: `dashboard/public/ari-mark-monochrome.svg`
- Create: `scripts/generate-ari-brand-assets.py`
- Create: `dashboard/public/ari-icon.png`
- Replace: `dashboard/public/favicon.ico`
- Create: `desktop/build/icon.png`
- Create: `desktop/build/icon.ico`
- Create: `desktop/build/icon.icns`

- [ ] **Step 1: Add the canonical transparent mark**

Use the approved geometry in `dashboard/public/ari-mark.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" role="img" aria-labelledby="ari-mark-title">
  <title id="ari-mark-title">Ari</title>
  <path d="M28 126 68 34c5-12 17-12 22 0l42 92h-25L79 64 53 126Z" fill="#8A65FF"/>
  <path d="M28 126 68 34 80 64 53 126Z" fill="#5A37D6"/>
  <path d="M58 99h44l-7-16H65Z" fill="#D8CCFF"/>
</svg>
```

- [ ] **Step 2: Add the icon, wordmark, and monochrome SVG variants**

`ari-icon.svg` uses a 1024 view box, a rounded `#17131F` tile, and the same paths scaled by `6.4`. `ari-wordmark.svg` places the mark beside the text `Ari` using a system sans-serif fallback. `ari-mark-monochrome.svg` uses one `currentColor` silhouette and a knockout crossbar.

- [ ] **Step 3: Add a deterministic Pillow exporter**

`scripts/generate-ari-brand-assets.py` draws the midnight rounded tile and the three approved polygons at 1024 px, saves the PNG, generates a multi-size ICO with `[16, 24, 32, 48, 64, 128, 256]`, and generates ICNS entries from 16 through 1024 px. It copies the 1024 PNG to both dashboard and desktop output paths and writes the favicon from the same image.

The source geometry is:

```python
SCALE = 1024 / 160
RIGHT = [(28, 126), (68, 34), (90, 34), (132, 126), (107, 126), (79, 64), (53, 126)]
LEFT = [(28, 126), (68, 34), (80, 64), (53, 126)]
CROSSBAR = [(58, 99), (102, 99), (95, 83), (65, 83)]
COLORS = {"midnight": "#17131F", "right": "#8A65FF", "left": "#5A37D6", "crossbar": "#D8CCFF"}
```

- [ ] **Step 4: Run the exporter**

Run:

```powershell
& 'C:\Users\dk557\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' scripts/generate-ari-brand-assets.py
```

Expected: the script prints every output path and all six generated binary assets are non-empty.

- [ ] **Step 5: Run Electron branding tests**

Run: `npm test --prefix desktop -- --test-name-pattern="Ari icons"`

Expected: still fails only because `desktop/package.json` has not yet been pointed to the new icons.

- [ ] **Step 6: Commit the asset system locally**

```powershell
git add scripts/generate-ari-brand-assets.py dashboard/public/ari-mark.svg dashboard/public/ari-wordmark.svg dashboard/public/ari-icon.svg dashboard/public/ari-mark-monochrome.svg dashboard/public/ari-icon.png dashboard/public/favicon.ico desktop/build/icon.png desktop/build/icon.ico desktop/build/icon.icns
git commit -m "feat: add Ari Prism brand assets"
```

## Task 3: Introduce the white-first Ari token system

**Files:**
- Modify: `dashboard/app/globals.css`
- Modify: `dashboard/tailwind.config.ts`
- Modify: `dashboard/app/layout.tsx`
- Modify: `dashboard/package.json`
- Modify: `dashboard/package-lock.json`

- [ ] **Step 1: Define semantic CSS variables**

Add to the top of `globals.css`:

```css
:root {
  --ari-surface: #ffffff;
  --ari-canvas: #fbfafe;
  --ari-surface-subtle: #f7f4ff;
  --ari-accent-soft: #f1ecff;
  --ari-border: #e8e3ed;
  --ari-border-strong: #dcd1ff;
  --ari-text: #18131f;
  --ari-text-muted: #817987;
  --ari-violet-700: #4c2cab;
  --ari-violet-600: #5a37d6;
  --ari-violet-500: #6e49e8;
  --ari-violet-400: #8a65ff;
  --ari-lavender: #d8ccff;
  --ari-midnight: #17131f;
}
```

Set `body` to `var(--ari-canvas)` and `var(--ari-text)`. Rework `.dash-card`, `.dash-card-hero`, `.card-soft`, `.dash-input`, `.dash-btn`, `.dash-btn-primary`, `.dash-tab-active`, and focus states to use the new semantic variables and a visible violet focus ring.

- [ ] **Step 2: Map Tailwind aliases to the same roles**

Use semantic names (`ari-surface`, `ari-canvas`, `ari-soft`, `ari-border`, `ari-text`, `ari-muted`, `ari-violet-*`, `ari-lavender`, `ari-midnight`). Keep existing names such as `page`, `card`, `card-purple`, and `btn-cta` as compatibility aliases, but map all decorative aliases into the approved white/violet scale.

- [ ] **Step 3: Update dashboard metadata and package identity**

Set the package name to `ari-dashboard`, declare `/ari-icon.svg` and `/favicon.ico` in Next metadata icons, and remove web-specific wording from the description so it describes the local Ari workspace.

- [ ] **Step 4: Run the focused token test**

Run: `npm test --prefix dashboard -- --test-name-pattern="token set|legacy decorative"`

Expected: token test passes; legacy decorative test may still fail in shared UI until Task 4.

- [ ] **Step 5: Run type checking**

Run: `npm run typecheck --prefix dashboard`

Expected: PASS.

- [ ] **Step 6: Commit the token system locally**

```powershell
git add dashboard/app/globals.css dashboard/tailwind.config.ts dashboard/app/layout.tsx dashboard/package.json dashboard/package-lock.json
git commit -m "feat: add Ari light theme tokens"
```

## Task 4: Apply Prism identity to shared application surfaces

**Files:**
- Modify: `dashboard/components/icons.tsx`
- Modify: `dashboard/components/sidebar.tsx`
- Modify: `dashboard/components/shell.tsx`
- Modify: `dashboard/components/dash-page.tsx`
- Modify: `dashboard/components/kpi-strip.tsx`
- Modify: `dashboard/components/command-palette.tsx`
- Modify: `dashboard/components/crm-subnav.tsx`
- Modify: `dashboard/components/import-csv-modal.tsx`

- [ ] **Step 1: Replace the legacy brand component**

Replace `WolfIcon` with:

```tsx
export function AriMark({ className }: IconProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/ari-mark.svg" alt="Ari" className={cx(className)} draggable={false} />
  );
}
```

- [ ] **Step 2: Apply the approved sidebar treatment**

Keep every existing route, dimension, account field, and mobile behavior. Replace the wolf image with `/ari-mark.svg`, use `ari-canvas`/`ari-border` for surfaces, use a lavender active fill with a violet leading indicator and violet icon color, replace the orange avatar with a violet gradient, and replace the yellow plan badge with a lavender pill.

- [ ] **Step 3: Update shell and shared page primitives**

Use `bg-ari-canvas text-ari-text` in the shell. Use the semantic surface, border, muted text, violet focus, and violet active-tab styles in topbars, tabs, pills, empty states, buttons, and command palette. Remove remote privacy/terms links from `PageFooter`; retain the Ari copyright and any caller-provided local content.

- [ ] **Step 4: Rework KPI accents without changing KPI data**

Use violet 600 for the single featured card, violet 400 and lavender for supporting cards/icons, and preserve labels, values, loading behavior, and grid layout.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm test --prefix dashboard -- --test-name-pattern="identity|legacy decorative"
npm run typecheck --prefix dashboard
```

Expected: both brand tests pass and type checking passes.

- [ ] **Step 6: Commit shared surfaces locally**

```powershell
git add dashboard/components/icons.tsx dashboard/components/sidebar.tsx dashboard/components/shell.tsx dashboard/components/dash-page.tsx dashboard/components/kpi-strip.tsx dashboard/components/command-palette.tsx dashboard/components/crm-subnav.tsx dashboard/components/import-csv-modal.tsx
git commit -m "feat: apply Ari identity to dashboard shell"
```

## Task 5: Recolor route surfaces and branded entry flows

**Files:**
- Modify: every path listed under “Route files mechanically recolored”
- Modify: `dashboard/app/login/page.tsx`
- Modify: `dashboard/app/get-started/page.tsx`
- Modify: `dashboard/app/auth/page.tsx`
- Modify: `dashboard/app/onboarding/page.tsx`
- Modify: `dashboard/app/onboarding/onboarding-form.tsx`

- [ ] **Step 1: Apply the bounded decorative-color mapping**

Apply these case-insensitive replacements only within the listed UI files:

```text
#fbfaf3 -> #FBFAFE   canvas
#e8e6dc -> #E8E3ED   border
#efece2 -> #E8E3ED   border
#7BD3F7 -> #8A65FF   electric violet
#9BE7BF -> #D8CCFF   lavender
#FFE38C -> #D8CCFF   lavender
#FF9D6E -> #6E49E8   primary violet
#4ADBC8 -> #8A65FF   electric violet
#818CF8 -> #8A65FF   electric violet
#DAF464 -> #D8CCFF   lavender
#7DFFB3 -> #6E49E8   primary violet
#FD693F -> #5A37D6   deep violet
#F2A3D8 -> #D8CCFF   lavender
#0a72a3 -> #4C2CAB   accessible violet text
```

Preserve `#ef4444`, `#F59E0B`, and `#3FAA6E` only where they represent actual error, warning, or success states. After each mechanical change, inspect the diff to confirm no copy, JSX structure, state logic, handler, or data flow changed.

- [ ] **Step 2: Replace branded entry marks**

Import and render `AriMark` on login and get-started. Use the same white-first surfaces, violet primary button, lavender secondary affordances, and violet focus states on authentication and onboarding screens.

- [ ] **Step 3: Remove visible remote calls to action**

Replace hosted links on login and onboarding with local Ari actions. Migrate compatibility cookies and database globals to Ari identifiers and keep Electron application navigation loopback-only.

- [ ] **Step 4: Add the complete visible-surface audit**

Extend `ari-brand-theme.test.ts` with the listed route paths and assert they do not contain `logo-wolf`, `WolfIcon`, remote product links, or the legacy decorative hex list.

- [ ] **Step 5: Run dashboard checks**

Run:

```powershell
npm test --prefix dashboard
npm run typecheck --prefix dashboard
```

Expected: all dashboard tests and type checking pass.

- [ ] **Step 6: Commit route recoloring locally**

Stage only the listed dashboard UI files and the theme test, then run:

```powershell
git commit -m "feat: apply Ari violet theme across dashboard"
```

## Task 6: Apply Ari branding to Electron packaging and startup

**Files:**
- Modify: `desktop/package.json`
- Modify: `desktop/src/startup.html`
- Test: `desktop/tests/branding.test.js`

- [ ] **Step 1: Point electron-builder at platform-native icons**

Set:

```json
"win": { "target": ["nsis"], "icon": "build/icon.ico" },
"mac": {
  "target": ["dmg", "zip"],
  "category": "public.app-category.productivity",
  "icon": "build/icon.icns"
}
```

- [ ] **Step 2: Recolor the startup window**

Keep the existing startup behavior and copy. Replace legacy colors with the approved canvas, midnight, violet, lavender, and border values; show the Prism A icon from an embedded local SVG or packaged data URI so startup never fetches a remote asset.

- [ ] **Step 3: Run Electron tests**

Run: `npm test --prefix desktop`

Expected: all Electron tests, including branding and loopback-navigation tests, pass.

- [ ] **Step 4: Build and smoke-test Windows locally**

Run:

```powershell
npm run build:win --prefix desktop -- --dir --config.directories.output=dist-brand-check
$env:ARI_REPO_ROOT='D:\Hackathon\ari-os-for-modern-team'; npm run smoke --prefix desktop
```

Expected: `desktop/dist-brand-check/win-unpacked/Ari.exe` exists, displays the Prism icon, and the smoke test exits 0.

- [ ] **Step 5: Verify macOS asset readiness**

Confirm `desktop/build/icon.icns` exists, contains multiple sizes, and electron-builder configuration resolves it. Do not attempt a macOS package on Windows; the package target is verified when run on macOS.

- [ ] **Step 6: Commit Electron branding locally**

```powershell
git add desktop/package.json desktop/src/startup.html desktop/tests/branding.test.js
git commit -m "feat: brand Ari desktop packaging"
```

## Task 7: Full verification and local preview

**Files:**
- Modify only if verification reveals a scoped branding/theme defect.

- [ ] **Step 1: Run all relevant automated checks**

Run:

```powershell
npm test --prefix dashboard
npm run typecheck --prefix dashboard
npm test --prefix desktop
npm test
```

Expected: all dashboard, Electron, and backend tests pass.

- [ ] **Step 2: Run the legacy surface audit**

Search dashboard application surfaces for the legacy logo, visible obsolete links, and migrated decorative palette. No legacy identifier is allowed.

- [ ] **Step 3: Launch the local Electron preview**

Run: `npm run desktop:dev`

Expected: Ari opens with the Prism icon, white-first dashboard, and violet interactions.

- [ ] **Step 4: Visually inspect representative surfaces**

Check dashboard home, sidebar, chat, reminders, tasks, contacts/CRM, inbox, meetings, messages, team, settings, login, onboarding, get-started, dialogs, empty states, error states, disabled controls, hover, focus, and mobile sidebar. Confirm white remains dominant and purple consistently means brand/action/selection.

- [ ] **Step 5: Inspect the final diff and working tree**

Confirm no website files, backend behavior, hosted-site files, deployment configuration, or unrelated user changes are staged. Do not push.

- [ ] **Step 6: Record verification fixes in the task that owns them**

If verification required a scoped fix, stage only the Ari files changed for that fix and commit them with `git commit -m "fix: complete Ari brand verification"`. If verification required no fix, leave the already verified task commits unchanged.
