# Ari Warm Product UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved warm, minimal Ari design system consistently across every logged-in product surface while preserving behavior.

**Architecture:** Centralize color, typography, spacing, focus, card, button, tab, table, and status rules in Tailwind aliases and `globals.css`. Refactor the shared workspace shell and page primitives first so feature pages inherit the system, then migrate remaining hardcoded feature styles and implement the approved CRM section flow.

**Tech Stack:** Next.js 14, React 18, TypeScript, Tailwind CSS 3, Node test runner, Electron desktop host.

---

### Task 1: Lock the design tokens with tests

**Files:**
- Modify: `dashboard/tests/ari-brand-theme.test.ts`
- Modify: `dashboard/app/globals.css`
- Modify: `dashboard/tailwind.config.ts`

- [ ] **Step 1: Add failing assertions for the warm token set**

Assert that globals define `--ari-product-canvas`, `--ari-nav`, `--ari-nav-active`, `--ari-ink`, `--ari-accent`, `--ari-focus`, `--ari-success`, and `--ari-danger`, and that shared UI no longer uses the violet primary palette.

- [ ] **Step 2: Run the focused brand test and confirm failure**

Run: `npm test -- --test-name-pattern="warm product token|complete Ari"`

Expected: FAIL because the warm tokens are not defined yet.

- [ ] **Step 3: Implement semantic tokens and Tailwind aliases**

Use the exact values in `docs/superpowers/specs/2026-07-18-ari-warm-product-design.md`. Keep legacy Tailwind aliases mapped to the new semantic colors so existing feature components remain functional during migration.

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- --test-name-pattern="warm product token|complete Ari"`

Expected: PASS.

### Task 2: Refactor the shared workspace shell

**Files:**
- Modify: `dashboard/components/shell.tsx`
- Modify: `dashboard/components/workspace-sidebar.tsx`
- Modify: `dashboard/components/workspace-header.tsx`
- Modify: `dashboard/components/workspace-tool-nav.tsx`
- Modify: `dashboard/components/recent-chats.tsx`
- Modify: `dashboard/components/profile-menu.tsx`
- Modify: `dashboard/tests/workspace-shell.test.ts`

- [ ] **Step 1: Extend shell tests for the approved structure**

Assert that the sidebar exposes a labeled collapse control, New session, the five approved top-level tools, Recent sessions, Settings, and Personal workspace; assert that the shell passes the toggle callback and uses the product frame classes.

- [ ] **Step 2: Run the shell test and confirm failure**

Run: `npm test -- --test-name-pattern="workspace side navigation|warm workspace shell"`

Expected: FAIL on missing toggle callback and warm frame classes.

- [ ] **Step 3: Implement the shell and sidebar structure**

Add an `onToggle?: () => void` prop to `WorkspaceSidebar`, place the toggle next to Ari, keep recent-session behavior intact, and retain collapsed mode. Update `Shell` to render the canvas plus rounded product frame and pass `onToggle`.

- [ ] **Step 4: Implement contextual header styling**

Derive the visible header title from `usePathname()`, preserve search behavior, and use shared button/icon classes. Keep the mobile navigation branch.

- [ ] **Step 5: Run shell tests**

Run: `npm test -- --test-name-pattern="workspace"`

Expected: PASS.

### Task 3: Refactor shared product primitives

**Files:**
- Modify: `dashboard/components/dash-page.tsx`
- Modify: `dashboard/components/crm-subnav.tsx`
- Modify: `dashboard/components/kpi-strip.tsx`
- Modify: `dashboard/components/command-palette.tsx`
- Modify: `dashboard/components/import-csv-modal.tsx`
- Modify: `dashboard/components/lead-form-slideover.tsx`
- Modify: `dashboard/app/globals.css`

- [ ] **Step 1: Add shared component style assertions**

Extend the brand test to require `ari-card`, `ari-button`, `ari-button-primary`, `ari-button-accent`, `ari-field`, `ari-table`, and `ari-status` classes.

- [ ] **Step 2: Run the brand test and confirm failure**

Run: `npm test -- --test-name-pattern="shared warm component"`

Expected: FAIL until the primitives are present.

- [ ] **Step 3: Implement the shared primitives**

Define the exact radii, borders, focus rings, type roles, and shadows from the design spec. Update page headers, KPI cards, CRM underline navigation, palette, modals, and slideovers to consume them.

- [ ] **Step 4: Run brand and component tests**

Run: `npm test -- --test-name-pattern="brand|workspace"`

Expected: PASS.

### Task 4: Align chat and desktop mode

**Files:**
- Modify: `dashboard/app/chat/chat-client.tsx`
- Modify: `dashboard/app/globals.css`
- Modify: `dashboard/components/desktop-window-mode.tsx`
- Modify: `dashboard/tests/agent-chat-workspace.test.ts`
- Modify: `dashboard/tests/desktop-window-mode.test.ts`

- [ ] **Step 1: Add assertions for shared warm shell usage in chat**

Require chat to pass the sidebar toggle callback and use warm product canvas/frame classes while retaining session, attachment, activity, and composer behavior.

- [ ] **Step 2: Run focused chat tests and confirm failure**

Run: `npm test -- --test-name-pattern="chat.*workspace|desktop window"`

Expected: FAIL on new structural assertions only.

- [ ] **Step 3: Apply the warm shell to chat**

Use the shared sidebar, warm header, white conversation surface, cream navigation, espresso send action, warm borders, and yellow focus states. Do not change request submission or session logic.

- [ ] **Step 4: Run focused chat and desktop tests**

Run: `npm test -- --test-name-pattern="chat.*workspace|desktop window"`

Expected: PASS.

### Task 5: Migrate logged-in feature surfaces

**Files:**
- Modify: product UI files under `dashboard/app` excluding `api`, `login`, `auth`, `onboarding`, and `get-started`
- Modify: product components under `dashboard/components`
- Modify: `dashboard/tests/ari-brand-theme.test.ts`

- [ ] **Step 1: Add a visible-surface palette guard**

Scan visible TSX files and reject the retired violet primaries and pink decorative accent when used as top-level product chrome. Permit semantic success, warning, error, Google brand colors, and data-series colors.

- [ ] **Step 2: Run the palette guard and record failing files**

Run: `npm test -- --test-name-pattern="visible dashboard surface"`

Expected: FAIL with the remaining page-specific files.

- [ ] **Step 3: Replace page-specific chrome with semantic classes**

Migrate Home, Team, Meetings, Tasks, Reminders, Scheduled emails, Notes, Productivity, and Settings. Preserve component APIs, loading states, errors, empty states, and interactions.

- [ ] **Step 4: Run the palette guard and product tests**

Run: `npm test`

Expected: PASS.

### Task 6: Implement the approved CRM information architecture

**Files:**
- Modify: `dashboard/components/crm-subnav.tsx`
- Modify: `dashboard/app/contacts/page.tsx`
- Modify: `dashboard/app/contacts/contacts-content.tsx`
- Modify: `dashboard/app/contacts/groups/page.tsx`
- Modify: `dashboard/app/contacts/groups/[id]/group-detail.tsx`
- Modify: `dashboard/app/contacts/campaigns/page.tsx`
- Modify: `dashboard/app/contacts/campaigns/campaigns-list.tsx`
- Create: `dashboard/app/contacts/activity/page.tsx`
- Create: `dashboard/app/contacts/activity/email-activity.tsx`
- Create: `dashboard/app/contacts/activity/[id]/page.tsx`
- Create: `dashboard/app/contacts/activity/[id]/message-performance.tsx`
- Create: `dashboard/app/contacts/analytics/page.tsx`
- Create: `dashboard/app/contacts/analytics/crm-analytics.tsx`
- Modify: `dashboard/tests/workspace-shell.test.ts`

- [ ] **Step 1: Add route and navigation assertions**

Require Contacts, Groups, Campaigns, Email activity, and Analytics links. Require the activity list to expose batch rows and the detail component to expose email content, metrics, and recipients.

- [ ] **Step 2: Run CRM-focused tests and confirm failure**

Run: `npm test -- --test-name-pattern="CRM|activity|analytics"`

Expected: FAIL because the new routes do not exist.

- [ ] **Step 3: Implement CRM pages with existing data contracts**

Reuse current contact, group, campaign, and email-tracking helpers. Render safe empty/demo states only where the existing API has no data. Keep destructive actions and sending behavior unchanged.

- [ ] **Step 4: Run CRM and full tests**

Run: `npm test`

Expected: PASS.

### Task 7: Verify the complete product migration

**Files:**
- Modify only files needed to address verification failures.

- [ ] **Step 1: Run TypeScript validation**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 2: Run the full dashboard tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next.js build succeeds.

- [ ] **Step 4: Render representative routes**

Capture desktop screenshots for Chat, Contacts, Email activity, Message performance, Team, Meetings, Tasks, and Settings; capture a mobile screenshot for Contacts and Chat. Compare palette, typography, icon weight, spacing, focus states, overflow, and shell consistency against the approved preview.

