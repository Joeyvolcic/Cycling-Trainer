# Integrations contract

Shared conventions so features built in parallel slot together. Keep this file current.

## Layout
- New feature code lives under `src/integrations/<name>/` (e.g. `ai`, `plans`, `calendar`, `media`, `quiz`, `analysis`).
- In-ride UI is a self-contained custom element `<x-<name>-panel>` (vanilla JS, matching `src/views/*` style, `xf` event bus).
- Panels are mounted into `<div id="integrations-dock"></div>` on the home page. The UI/layout work owns that container and how panels are arranged (tabs/switcher); feature agents just register their element.
- Register a panel by calling `registerPanel({id, title, icon, element})` from `src/integrations/registry.js`.
  - `element` may be EITHER a custom-element tag name string (e.g. `'x-quiz-panel'`) OR an `HTMLElement` instance
    (the dock also accepts an element class or a zero-arg factory). Tag names are created with `document.createElement`
    lazily, the first time the panel is shown.
  - `icon` is optional: a short text/emoji or inline `<svg>` markup. `title` is shown on the tab (keep it to 1-2 words).
- Dock behaviour (`src/integrations/ui/dock.js`, styles in `src/css/layouts.css`):
  - One panel visible at a time, chosen from a pill tab bar (hidden when only one panel exists). The last choice is
    remembered in `localStorage['ui:dock-panel']`.
  - Once created, a panel stays mounted; switching tabs only toggles the `hidden` attribute on its `<section class="dock--panel">`
    host, so audio/quiz state survives. Don't rely on `connectedCallback` firing again on tab switches; listen to the
    `xf` event `integrations:active` (detail = active panel id) if you need to know.
  - Panels must size to their container (`height: 100%`, scroll internally) — the dock can be anything from ~250px
    (Focus layout, expanded workout) to a full half-screen. Use `container-type`/container queries rather than
    viewport media queries for internal responsiveness.
  - Dispatch `xf.dispatch('ui:dock:select', '<id>')` to bring your panel to the front (e.g. coach alert).
  - The active layout is on `<body data-layout="classic|banner|split|focus">` and announced via `xf` event `ui:layout`.
    In `classic` the dock sits below the full-screen data view (scroll down) and only appears once a panel is registered.
- Settings for a feature go in a `<section id="<name>-settings">` inside the Settings page; keep edits to shared files (`index.html`, `models.js`, `flux.css`, `db.js`) minimal and additive to ease merging.
- Persist secrets/tokens only in `localStorage` under `<name>:*` keys (no backend we control; `api.auuki.com` is upstream's).
- Everything must work on iPad (touch targets >= 44px, no hover-only UI, no keyboard-only shortcuts).

## Shared data
- AI client: `src/integrations/ai/claude.js` exports `isConfigured()` and
  `async complete({system, prompt, json=false, maxTokens})` -> string (or parsed object when `json`).
  Uses the user's Anthropic key from `localStorage['ai:anthropic-key']`. Consumers must check `isConfigured()` and degrade gracefully.
- Training plan (IndexedDB store `plans`, module `src/integrations/plans/plans.js`):
  ```js
  TrainingPlan = { id, name, description, startDate: 'YYYY-MM-DD', goal,
    entries: [{ id, date: 'YYYY-MM-DD', workoutId, workoutName, notes,
                targetTime?: 'HH:MM', durationMin,
                status: 'planned'|'done'|'skipped', activityId?, calendarEventId? }] }
  ```
  Exports: `listPlans, getPlan, savePlan, deletePlan, entriesForDate(date), updateEntry(planId, entryId, patch)`.
  Dispatches `xf` event `plans:changed`.
- Wellness/recovery: `src/integrations/ai/wellness.js` exports `async getWellness(date)` -> `{sleepScore?, sleepHours?, hrv?, restingHR?, readiness?, source}` (intervals.icu wellness first).
- Ride summary for analysis: `src/integrations/analysis/summary.js` exports `summarizeActivity(activity)` -> plain JSON (duration, avg/NP power, HR stats, time-in-zone, interval compliance).
