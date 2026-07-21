# Ari Prism Brand and Light Theme Design

**Date:** 2026-07-16  
**Status:** Approved visual direction; ready for implementation planning

## Goal

Replace the remaining legacy wolf identity in the Ari desktop dashboard with the approved Prism A identity and a cohesive light-only color system. The existing dashboard structure, information architecture, content, and feature behavior remain unchanged.

This design note covers the initial desktop visual implementation only. It does not define Ari's current hosted product architecture.

## Approved Direction

### Identity

The primary mark is the approved **Prism A**: a folded violet A monogram composed of three planes.

- Right plane: electric violet `#8A65FF`
- Left plane: deep violet `#5A37D6`
- Crossbar: soft lavender `#D8CCFF`
- Dark icon background: midnight `#17131F`
- Wordmark: `Ari`

The mark must not include a wolf, headset, the letter S, or any legacy-brand reference.

### Theme

Ari is a light-only application.

- White is the primary surface.
- Soft neutral and lavender-tinted whites create depth between the page, sidebar, cards, fields, and hover states.
- Deep violet is reserved for primary actions and high-emphasis selected states.
- Electric violet identifies active navigation, focus, and branded icons.
- Lavender is used for subtle fills, rings, badges, and supporting highlights.
- Purple must not become a general-purpose background wash across the full application.

The approved intensity is **Balanced Violet, refined**. The layout shown in the visual preview is illustrative; implementation preserves the current dashboard layout.

## Design Tokens

The implementation will centralize colors as named CSS variables and mirror them in Tailwind aliases where existing components use utility classes.

| Role | Token | Value |
| --- | --- | --- |
| Primary surface | `--ari-surface` | `#FFFFFF` |
| Page canvas | `--ari-canvas` | `#FBFAFE` |
| Subtle surface | `--ari-surface-subtle` | `#F7F4FF` |
| Soft accent surface | `--ari-accent-soft` | `#F1ECFF` |
| Border | `--ari-border` | `#E8E3ED` |
| Strong border | `--ari-border-strong` | `#DCD1FF` |
| Primary text | `--ari-text` | `#18131F` |
| Muted text | `--ari-text-muted` | `#817987` |
| Violet 700 | `--ari-violet-700` | `#4C2CAB` |
| Violet 600 | `--ari-violet-600` | `#5A37D6` |
| Violet 500 | `--ari-violet-500` | `#6E49E8` |
| Violet 400 | `--ari-violet-400` | `#8A65FF` |
| Lavender | `--ari-lavender` | `#D8CCFF` |
| Midnight | `--ari-midnight` | `#17131F` |

Focus rings use electric violet with sufficient offset from white surfaces. Primary violet buttons use white text and the darker violet values required to meet WCAG AA contrast.

Semantic error, warning, and success colors may remain red, amber, and green only when they communicate real status. They are not part of the brand palette and must not be used for ordinary decoration.

## Component Treatment

### Application shell and sidebar

- Keep the current sidebar width, navigation order, account block, search trigger, mobile drawer, and footer.
- Replace the wolf image with the Prism A mark and `Ari` wordmark.
- Use white for the sidebar and a subtle neutral-violet border.
- Use a pale lavender fill, violet leading indicator, and violet icon treatment for the active route.
- Use neutral hover states for inactive routes so purple continues to signify selection.
- Replace legacy cyan, mint, orange, and yellow decorative fills with Ari neutrals or violets.

### Page canvas and cards

- Use the canvas token for the app background and white for cards.
- Preserve existing card sizes, grids, spacing, typography, and content.
- Standard cards receive a subtle border and restrained neutral-violet shadow.
- Featured or active cards may use a lavender tint or deep-violet fill, but no more than one strongly filled card should dominate a single dashboard section.

### Buttons, tabs, fields, and interaction states

- Primary buttons use a deep-violet fill, white text, and a restrained violet shadow.
- Secondary buttons remain white with a neutral-violet border.
- Active tabs use deep violet or a lavender fill depending on emphasis.
- Inputs remain white; hover borders darken slightly and focus uses the violet ring.
- Disabled states use neutral opacity and never rely on hue alone.
- Keyboard, hover, active, selected, loading, and error states must remain visibly distinct.

### Icons, badges, and data visualization

- Branded feature icons use electric violet on a lavender surface.
- High-emphasis icons may use white on deep violet.
- Plan and neutral badges use lavender rather than legacy yellow.
- Charts and progress indicators use the violet scale first, with semantic colors only when the data meaning requires them.

### Authentication and onboarding

- Replace all legacy logos and accent colors on login, authentication, onboarding, and get-started screens.
- Preserve existing forms, copy, and flows.
- Use the same white-first surfaces and violet interaction rules as the signed-in dashboard.

## Logo Asset System

Create a single canonical vector source for the Prism A mark, then derive all app assets from it.

- Standalone SVG mark for UI use
- Horizontal Ari wordmark lockup for places that need text plus mark
- Monochrome SVG fallback for constrained contexts
- Dashboard PNG fallbacks where an image source is required
- Windows `.ico` containing the required desktop icon sizes
- macOS `.icns` containing the required desktop icon sizes
- High-resolution PNG source suitable for packaging and future store assets
- Browser favicon assets

The desktop icon uses the Prism A centered on a rounded midnight tile. UI locations that already provide their own container use the transparent mark so the icon is not rendered as a tile inside another tile.

The mark must remain recognizable at 16 px. At small sizes, preserve the silhouette and crossbar; avoid thin decorative details.

## Implementation Boundaries

The implementation is limited to:

1. Brand and theme tokens.
2. Shared dashboard component styling.
3. Removal of legacy decorative colors from dashboard, authentication, onboarding, and desktop-facing surfaces.
4. Replacement of logo, favicon, and Electron packaging icons.
5. Tests and visual verification needed to confirm consistent application.

The following are explicitly out of scope:

- Feature redesigns or navigation changes
- Copy changes unrelated to the Ari name
- Website or hosted-product changes
- Hosting or deployment
- GitHub pushes or releases
- Dark mode

## Architecture and Data Flow

The theme is presentation-only and does not alter application data flow.

- CSS variables define the source palette and semantic roles.
- Tailwind aliases reference those roles for existing utility-based components.
- Shared component classes consume semantic roles rather than raw legacy hex values.
- Route-level components continue to receive and render the same data.
- Electron loads the same local dashboard and consumes the packaged icon assets through its existing configuration.

Centralizing the palette prevents individual pages from drifting and makes later brand adjustments possible without another full codebase search.

## Fallbacks and Failure Handling

- SVG logos include meaningful `alt` text when rendered as images; decorative instances are hidden from assistive technology.
- If an image fallback fails, the visible `Ari` wordmark remains so the application is still identifiable.
- Packaging must fail clearly if required Windows or macOS icon assets are missing.
- The theme must not hide validation errors, disabled controls, focus indicators, or status information.
- No implementation path may fetch brand assets from a remote domain.

## Verification

### Automated

- Run dashboard type checking and existing dashboard tests.
- Run existing Electron tests.
- Add focused tests for logo references and theme-token usage where they provide durable protection.
- Verify the Electron packaging configuration resolves Windows and macOS icons.
- Search application-owned desktop and dashboard surfaces for legacy logo filenames, legacy copy, and superseded decorative color values.

### Visual

Inspect at minimum:

- Dashboard home
- Sidebar active, inactive, hover, mobile, and account states
- Chat, reminders, tasks, contacts/CRM, inbox, meetings, team, messages, and settings
- Login, authentication, onboarding, and get-started screens
- Buttons, tabs, form fields, badges, dialogs, loading, empty, error, and disabled states
- Windows desktop icon at large and small sizes
- macOS packaging icon assets at source sizes

Check common desktop widths and the existing mobile dashboard breakpoint. Confirm that white remains dominant, violet has a consistent meaning, text contrast remains readable, and no layout or feature behavior changed.

## Acceptance Criteria

The design is complete when:

1. Every user-visible Ari desktop and dashboard surface uses the Prism identity.
2. No wolf, S mark, hosted-product dependency, or legacy brand asset remains in those surfaces.
3. White is visibly the dominant app color and the approved purple hierarchy is applied consistently.
4. Existing dashboard structure and feature behavior remain unchanged.
5. Required Windows and macOS icon assets exist and are referenced by the Electron packaging configuration.
6. Dashboard and Electron automated checks pass.
7. Visual review finds no unreadable, missing, or inconsistent interaction states.
8. All work remains local and nothing is pushed or deployed.
