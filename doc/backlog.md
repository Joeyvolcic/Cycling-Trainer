# Feature backlog

Ordered by priority within each section. Items come from rides, the feature build-out, and open questions the
feature work left behind.

## Now: make it reliable for real rides
- [ ] **Real-hardware check on iPad (Bluefy):** pair trainer and HR strap, auto-reconnect, screen stays awake, run one full workout. Checklist in `doc/ipad.md`.
- [ ] **Tune heart-rate mode on a real ride:** gains were tuned on a simulated rider; check response speed and overshoot.
- [ ] **Pick the default layout** (Banner / Split / Focus) and make it the default on iPad.
- [ ] **FTP from ramp test:** when the Ramp Test ends, compute 75% of the last full minute and offer to save it as FTP.
- [ ] **Auto-deploy to GitHub Pages:** a GitHub Action that builds and publishes on push (today it's a manual build pushed to `gh-pages`).

## Ride history
- [ ] **History page:** list every ride with date, duration, power/HR summary and coach rating; open the ride report from it.
- [ ] **Pull past rides from intervals.icu** so history is the same on iPad, PC and auuki.com rides.
- [ ] **Backfill analysis** for rides saved before the analysis feature by decoding their FIT files.
- [ ] **Backup and restore:** export all rides, plans, workouts and quiz decks as one file; import on another device.
- [ ] **Trends:** FTP over time, weekly hours/TSS, fitness/fatigue (CTL/ATL) chart.

## Training and AI
- [ ] **Plan my week from the Plans page** (today it's only in the AI panel and Settings).
- [ ] **Scheduler respects rides already in the plan** when choosing times.
- [ ] **Keep plan-change proposals** across reloads; clear the old proposal when feedback is requested again.
- [ ] **Tidy AI-adjusted workouts** in the library (group or auto-archive them).
- [ ] **Readiness adjustments for HR-target workouts** (today it only scales power).
- [ ] **HR safety ceiling defaults** to a percentage of max HR when left empty.
- [ ] **Higher-effort option for planning** (better plans, higher API cost).
- [ ] **Sync FTP and zones with Strava/intervals.icu.**

## Integrations
- [ ] **intervals.icu sign-in with wellness and activity access**, so the separate API key isn't needed.
- [ ] **Calendar sync without reconnecting hourly:** needs a small backend for refresh tokens.
- [ ] **Subscribable calendar feed** (webcal URL) instead of re-importing .ics files.
- [ ] **Verify Spotify login from the iPad home-screen app** and audiobook resume against the live API.
- [ ] **Quiz:** per-deck language for read-aloud; configurable intensity thresholds.

## App quality
- [ ] **Fix the 52 older failing tests** (timezone-dependent dates, FIT, BLE, idb test setup).
- [ ] **Offline support:** add new files to the service worker precache and enable it.
- [ ] **Smaller bundle:** load the Anthropic SDK only when AI is used (main bundle is about 1 MB).
- [ ] **Bring back the quick-start card** after it's dismissed (`ui:quick-start:show` is never sent).
- [ ] **Configurable Focus layout timings** and which metrics the compact layouts show.
- [ ] **Clean up upstream HTML issues:** duplicate ids and stray closing tags in `src/index.html`.
