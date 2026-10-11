# Integrations contract

Shared conventions so features built in parallel slot together. Keep this file current.

## Layout
- New feature code lives under `src/integrations/<name>/` (e.g. `ai`, `plans`, `calendar`, `media`, `quiz`, `analysis`).
- In-ride UI is a self-contained custom element `<x-<name>-panel>` (vanilla JS, matching `src/views/*` style, `xf` event bus).
- Panels are mounted into `<div id="integrations-dock"></div>` on the home page. The UI/layout work owns that container and how panels are arranged (tabs/switcher); feature agents just register their element.
- Register a panel by calling `registerPanel({id, title, icon, element})` from `src/integrations/registry.js`.
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
- Media (`src/integrations/media/`, see `doc/media.md`): panel id `media`, keys `media:*` in localStorage, own IndexedDB
  database `flux-media` (does not touch `src/db.js`). Emits `media:segment` `{index, type, playlist}` on workout interval
  changes, with `type` in `warmup|endurance|threshold|vo2|recovery` (pure helpers in `media/intensity.js`).
