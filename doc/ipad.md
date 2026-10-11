# iPad readiness

Status as of October 2026. This covers what works, what can't work, and what the app now does about it.

## The hard constraint: no Web Bluetooth / WebUSB in iPadOS browsers

- **Safari on iPadOS/iOS has no Web Bluetooth, WebUSB or Web Serial**, and Apple has announced no plans to add them.
  Every iOS browser (Chrome, Edge, Firefox...) is required to use WebKit, so none of them have these APIs either.
  (The EU allows alternative engines, but I couldn't confirm that any browser with Web Bluetooth ships on iPad that way.
  Re-check before relying on it.)
- So on iPad in Safari the app **cannot connect to a trainer, power meter, HRM or ANT+ stick**. Before this change it
  failed silently: `navigator.bluetooth` was undefined, the connect call threw inside a try/catch, and the indicator stayed red.
- **Workaround: [Bluefy – Web BLE Browser](https://apps.apple.com/app/id1492822055)** (free, iPhone and iPad, iPadOS 12+). It is a
  WKWebView browser that injects a `navigator.bluetooth` implementation (Central role, GATT), and it needs HTTPS.
  This is the option the app recommends.
  - Unverified risks to test on a real trainer: `navigator.bluetooth.getDevices()` (which auto-reconnect relies on in `src/ble/connectable.js`
    `watch()`) may be missing, so auto-reconnect after a drop could fail and the rider would have to tap again.
    Some users report Bluefy's `requestDevice` filter matching differs from Chrome's (see the W3C web-bluetooth issue #624).
  - Bluefy can't install the app as a home-screen PWA. It runs inside the Bluefy app.
  - The Wake Lock API may not be exposed in Bluefy. The guidance tells riders to set Auto-Lock to Never.
  - An older alternative, "WebBLE" (daphtdazz/WebBLE), is unmaintained. A newer Safari extension, "iOSWebBLE",
    claims Web Bluetooth inside Safari itself. It is unverified, so we don't recommend it yet.
- **ANT+ USB sticks can't work on iPad in any browser** (no WebUSB/Web Serial).

## What the app does now

| Area | Implementation |
|---|---|
| Detection | `src/integrations/ui/platform.js`: `isIOS` / `isIPad` (iPadOS 13+ reports a Mac UA, so it uses `maxTouchPoints > 1`), `isStandalone`, `capabilities()`. It adds `is-ios`, `is-ipad`, `is-touch`, `is-standalone` and `no-bluetooth` classes on `<html>`. |
| Guidance | `<compatibility-check>` now shows platform-specific text that can be dismissed: on iPad it gives Bluefy steps, on desktop it points to Chrome/Edge. Tapping any connect switch without Web Bluetooth opens a dialog explaining why (`src/integrations/ui/ipad.js`). ANT+ switches explain that WebUSB is missing. |
| Home-screen app | `apple-mobile-web-app-capable`, `mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style=black-translucent`, `apple-mobile-web-app-title`, the existing 180×180 `apple-touch-icon`, and the manifest. Add to Home Screen gives a full-screen app, which is useful for workouts and integrations but has no Bluetooth (still WebKit). |
| Safe areas | `viewport-fit=cover`, plus `env(safe-area-inset-*)` padding on `.wrapper` and the bottom bar (home indicator), and top padding in standalone mode under the translucent status bar. |
| Touch targets | At least 44 px for watch controls, connect switches, mode tabs, number +/-, dock tabs, layout buttons, sound controls and the mode lock. The new UI uses `click` (no hover-only paths). The existing workout-graph tooltip is hover-driven but optional. |
| Accidental zoom/scroll | `touch-action: manipulation` on the ride UI (removes double-tap zoom), `overscroll-behavior: none` (no rubber-band or pull-to-refresh), `user-select`/`-webkit-touch-callout: none` on the ride UI, and inputs ≥16 px on iOS (avoids focus zoom). Pinch (`gesturestart`/`gesturechange`) and ctrl+wheel are blocked **only while the timer runs**. `user-scalable=no` isn't used because iOS ignores it. |
| Wake lock | `src/lock.js` already requested a lock at load. It now also re-requests on `watch:started` (a user gesture, which Safari needs) and on the next touch after a release (up to 3 failures). It also fixes a bug where `isVisible` was never refreshed after the page became visible again. Safari supports the Screen Wake Lock API from iPadOS 16.4. Home-screen (standalone) web apps had a WebKit bug where the lock didn't hold. It was reportedly fixed in iOS 18.4, but I haven't verified that on a device. Riders on older versions should set Auto-Lock to Never. |

## Layout on iPad

Settings › Options › Layout (or the layout button in the top bar) switches between Classic, Banner, Split and Focus.
Measured on an iPad Air 11" (1180×820 CSS px, about 0.19 mm per px):

| Layout | Power digits (landscape / portrait) | Integrations area |
|---|---|---|
| Classic | ~82 px / ~102 px | none (scroll below) |
| Banner | ~61 px / ~82 px | ~60% |
| Split | ~74 px / ~82 px | 50% |
| Focus | 61 px collapsed → 90 px+ expanded | 64% → 34% |

61 px is about 8.4 mm cap height, which reads at a glance from about 1 m (roughly 25 arcmin). See `doc/ui-proposals/index.html`.

## Manual test checklist (real iPad)

1. Open in Safari and check that the red banner explains Bluefy, can be dismissed, and that tapping Trainer opens the guide dialog.
2. Add to Home Screen, launch it, and check the status bar doesn't cover the header and the bottom bar clears the home indicator.
3. In Bluefy, pair a trainer and HRM, start a workout, leave the iPad untouched for 5 minutes, and check the screen stays on.
4. Switch through all layouts in landscape and portrait. Rotate the device mid-ride.
5. Mid-ride, double-tap and pinch on the tiles: nothing should zoom. Swipe on the dock: it scrolls, but the page doesn't bounce.
6. Disconnect the trainer (power it off and on) and check whether Bluefy reconnects automatically (`getDevices`).
