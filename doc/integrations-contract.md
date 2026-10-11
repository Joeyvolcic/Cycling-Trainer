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
  Each section sits in its own collapsible `<details class="integration-section" data-section="<name>">` under the
  Settings page's "Integrations" heading (`#integrations-settings`); the `<summary>` is the heading, so don't render a
  top-level heading of your own. `xf.dispatch('ui:settings:open', '<name>')` opens and scrolls to a section
  (`src/integrations/ui/settings-sections.js`).
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
  Dispatches `xf` event `plans:changed` with `{action: 'save'|'delete'|'entry', planId, entryId?}`.
  `entriesForDate` returns entries tagged with `planId` and `planName`. Entries may carry an optional
  `workout` snapshot (`{meta, intervals}`) so plans stay portable; resolve with `resolveWorkout(entry, db.workouts)`.
  Extras: `createPlan, addEntry, addWorkout, removeEntry, moveEntry, reorderEntry, duplicateWeek,
  exportPlan, importPlan, hasPlannedToday, todayISO, addDays, weekStart`.
  IDB `store` is at version 4 with stores `['session','workouts','activity','plans']`; any version bump now
  creates missing stores, so add yours to the list in `db.js` and bump the version.
  Today's entry is loaded as the workout on startup (local plan wins over intervals.icu); `ui:plans:ride {planId, entryId}`
  loads an entry; `plans:today {entry, workout}` / `plans:active` are dispatched; a saved activity marks the entry `done`
  (also when the ridden workout is an adjusted copy with `meta.adjustedFrom` = the entry's workout id).
  Startup precedence for the current workout (only `plans/today.js` and `models.planned.wod()` auto-load):
  resumed ride > deep link (`app:deeplink`) > today's local plan entry > intervals.icu planned workout.
  The quick-start card and the AI readiness panel only load a workout on user action (quick start uses `ui:plans:ride`).
- Wellness/recovery: `src/integrations/ai/wellness.js` exports `async getWellness(date)` -> `{sleepScore?, sleepHours?, hrv?, restingHR?, readiness?, source}` (intervals.icu wellness first).
- Ride summary for analysis: `src/integrations/analysis/summary.js` exports `summarizeActivity(activity)` -> plain JSON (duration, avg/NP power, HR stats, time-in-zone, interval compliance).
- Heart-rate control (`src/integrations/hr-control/`): `ControlMode.heartRate` (`'heartRate'`) is a software loop on top of ERG.
  Trainer code must use `isPowerTargetMode(mode)` from `src/ble/enums.js` (true for `erg` and `heartRate`) before sending power targets.
  State: `db.heartRateTarget` (bpm), events `ui:heart-rate-target-set|inc|dec`; status broadcast as `hr-control:status`
  `{active, status, power, target, smoothedHr, message}`. Workout steps may carry `heartRate`, parsed from zwo
  `HeartRate` / `OnHeartRate` / `OffHeartRate` attributes, and as linear ramps on `Warmup` / `Ramp` / `Cooldown` via
  `HeartRateLow` (start) / `HeartRateHigh` (end). A value <= 2 is a fraction of LTHR, > 2 is bpm; it is resolved to bpm
  when the step starts (`toBpm()` in `hr-control/targets.js`). LTHR / max HR are the analysis settings
  (`analysis:lthr`, `analysis:max-hr`, `athlete()` in `analysis/settings.js`), the single source of truth; changes
  dispatch `analysis:settings`. Other HR control settings in `localStorage['hr-control:*']`.
- Calendar: `src/integrations/calendar/calendar.js` exports
  `async scheduleEntries(entries, prefs?, options?)` -> `[{entryId, date, time, start, end, shiftedDays, hard, warnings, reason?}]`
  (pure core in `scheduler.js`; uses Google free/busy when connected), `syncAll()`, `exportIcs()`.
  Sync writes `calendarEventId` (and `date` when a ride had to be moved) via `updateEntry`.
  Deep links `?workout=<id>` / `?planEntry=<id>&plan=<id>` are routed by `src/models/api.js` as xf event `app:deeplink`.
- Quiz (spaced repetition, `src/integrations/quiz/`): own IndexedDB database `flux-quiz` (stores `decks`, `cards`, `reviews`; does not touch the shared `store` DB),
  settings in `localStorage['quiz:settings']`, last ride summary in `localStorage['quiz:last-ride']`.
  Panel `x-quiz-panel` (registered with `element: 'x-quiz-panel'`, a tag name), manager `x-quiz-manager` in `#quiz-settings`, `x-quiz-ride-summary` in the ride report.
  Reads `db:watchStatus`, `db:powerTarget`, `db:power3s`, `db:ftp`. Dispatches `quiz:changed`, `quiz:settings`, `quiz:state`,
  and `quiz:ride-summary` -> `{reviewed, correct, start, end}` on ride stop (usable by analysis).
- Media (`src/integrations/media/`, see `doc/media.md`): panel id `media`, keys `media:*` in localStorage, own IndexedDB
  database `flux-media` (does not touch `src/db.js`). Emits `media:segment` `{index, type, playlist}` on workout interval
  changes, with `type` in `warmup|endurance|threshold|vo2|recovery` (pure helpers in `media/intensity.js`).
  Also exports `toStreams(activity)`. Saved activities get `record.analysis = {input, summary, feedback, quiz}` in the IDB `activity` store
  (feedback from the post-ride "Coach feedback"; `quiz` = the `quiz:ride-summary` of that ride when cards were reviewed, else null). Upload retry queue lives in its own IDB database `flux-analysis` (store `uploads`).
  Events: `analysis:report` / `analysis:report:open` (open the post-ride report for an activity id), `analysis:upload` (queue job changed),
  `analysis:upload:request` `{id, service}`. Credentials: `analysis:intervals-athlete-id`, `analysis:intervals-api-key`, `analysis:strava-*`.
- AI plan builder / coach plan changes (`src/integrations/ai/planner*.js`): Claude only *chooses* (catalog refs `w1..`,
  entry refs `e1..`, typed steps / actions via structured outputs); `planner-core.js` validates, clamps and builds
  everything deterministically (custom workouts from steps, adjustments via `adjust.js`). Accepted plans are written with
  workout snapshots, times from `calendar.scheduleEntries` (stored as `targetTime`), then `syncAll()` when Google is connected
  (else the UI offers `.ics`). Entries may carry `hard` (bool, used by the scheduler), `source: 'ai'|'ai-custom'` and
  `adjustedFrom: {workoutId, workoutName, workout?, by: 'readiness'|'coach', at, lastDecision?}` (the first original is kept).
  Readiness "Accept" also saves the adjusted workout to the library (`ui:workout:save`) and links it from the entry, then
  loads it with `ui:plans:ride` so the ride matches the entry. Elements: `<x-ai-planner>` (AI panel + Settings),
  `<x-ai-plan-changes data-activity-id>` (post-ride report). Events: `ai:planner:state`, `ai:planner:accepted`, `ai:plan-changes:applied`.
