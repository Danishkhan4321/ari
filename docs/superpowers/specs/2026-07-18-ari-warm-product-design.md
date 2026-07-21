# Ari Warm Product Design Specification

## Scope

Apply the approved warm, minimal CRM preview design across the logged-in Ari product in `dashboard/` and the Electron desktop shell that hosts it. Keep the public `website/` unchanged. Preserve existing behavior, routes, data loading, accessibility semantics, and desktop integrations.

## Visual system

- Product canvas: `#e8e9ec` on wide desktop surfaces.
- Main surface: `#ffffff`.
- Navigation surface: `#fffdf3`.
- Selected navigation: `#f4f0cf`.
- Primary ink and CTA: `#260805`.
- Primary text: `#201310`.
- Secondary text: `#706965`.
- Borders: `#dfddda`.
- Subtle surface: `#faf9f6`.
- Primary accent: `#f7dd2a`.
- Supporting accents: lilac `#eee4fa`, blue `#dfe9ff`, lime `#eefaca`, peach `#ffe8d6`.
- Success: `#1d7a32`; danger: `#bd2b2b`.

## Typography

Use one modern sans-serif family across product surfaces: Figtree with Segoe UI and system fallbacks. Use Regular 400 for body copy, Medium 500 for controls and data labels, and Semibold 600 only for important titles and emphasized values. Avoid Light/Thin weights and avoid editorial serif type inside the product.

Type roles:

- Product/header title: 23px/30px, 600.
- Page title: 29px/36px, 600.
- Section title: 18px/26px, 600.
- Card/data title: 14–15px/20px, 500–600.
- Body: 14px/21px, 400.
- Table: 13px/20px, 400.
- Label/metadata: 10–12px/16px, 400–500.
- KPI: 27px/32px, 500 with tabular figures.

## Shared shell

The wide desktop product sits in a rounded white workspace frame on the gray product canvas. The cream sidebar contains the Ari mark and an adjacent collapse control, New session, Home, CRM, Team, Meetings, Personal workspace, live recent sessions, Settings, and the personal-workspace profile. Mobile keeps the existing adaptive navigation behavior.

The top header uses a contextual page title, notification/search controls, and a contextual primary action where applicable. Controls use thin borders, 8–11px radii, consistent line icons, and visible yellow focus rings.

## Product components

- Cards: white surface, 1px warm border, 12–15px radius, restrained shadow.
- Buttons: 40–44px height; espresso primary, yellow accent for task-level actions, white outlined secondary.
- Tabs: underline navigation for page sections; dark segmented controls for status groups.
- Tables: warm-white header, small uppercase column labels, 52–58px rows, tabular numeric columns.
- Statuses: text plus dot; color is never the only signal.
- Forms: visible labels, 42–44px controls, yellow focus ring, nearby errors.
- Icons: existing Ari SVG icon components; consistent outline weight; no emoji structural icons.

## CRM information architecture

CRM section navigation is Contacts, Groups, Campaigns, Email activity, and Analytics. Email activity is batch-first: each bulk send is one row. Opening a send shows its exact email, aggregate metrics, delivery plan, and filterable recipient-level results on one detail screen.

## Accessibility and responsive behavior

Maintain WCAG 2.2 AA text contrast, keyboard navigation, focus visibility, semantic labels, reduced-motion behavior, 44px touch targets for primary interactions, 200% zoom compatibility, and no horizontal page overflow. Data tables may scroll within their own responsive container.

## Non-goals

- No changes to public marketing pages.
- No backend or data-model redesign as part of the visual migration.
- No removal of existing product functionality.
- No unrelated repository cleanup.

