# Music, podcasts & audiobooks while riding

Code: `src/integrations/media/` (entry `media.js`, panel `<x-media-panel>`, settings `<x-media-settings>` in `#media-settings`).

## Spotify setup (each user, once)

1. Open https://developer.spotify.com/dashboard and **Create app**.
2. Add a **Redirect URI** that exactly matches the address the app is served from, without query or hash.
   Settings > Music & podcasts shows the exact value with a Copy button. Examples:
   - production: `https://your-flux-host.example/`
   - local dev: `http://127.0.0.1:1234/` (Spotify rejects `http://localhost`; open the dev server via `127.0.0.1`)
3. Tick **Web API** and **Web Playback SDK**. Save, then copy the **Client ID** into Settings
   (`localStorage['media:spotify-client-id']`). No client secret: the app uses Authorization Code + PKCE.
4. Development-mode apps only work for accounts listed under **User Management**; add your Spotify e-mail.
5. Playback control through the Web API (play/pause/skip/seek/volume/transfer, intensity playlists) needs **Spotify Premium**.
   Free accounts can connect and browse; the UI says so.

Tokens are stored in `localStorage['media:spotify-token']` and refreshed one minute before expiry
(and on returning to the tab, since iPad suspends timers in the background).

If the login redirect opens in Safari instead of the home-screen app, copy the Safari address
(it contains `?code=`) into Settings > "Login came back in Safari instead of the app?".

## iPad vs desktop

| | iPad / iPhone (any browser, all WebKit) | Desktop Chrome/Edge/Firefox/Safari |
|---|---|---|
| In-page Spotify audio (Web Playback SDK) | Not supported | Yes, as device "Flux Trainer" (Premium) |
| Control the Spotify app (Spotify Connect Web API) | Yes: the Spotify app on the iPad (or any phone/computer/speaker) | Yes |
| RSS podcasts / local audio files | Yes (`<audio>`; lock-screen controls via Media Session) | Yes |

On iPad: open the Spotify app and play anything briefly so it shows up as a device, then come back to Flux
(Split View works well). Devices disappear after a period of inactivity; the Devices list has Refresh and an
"Open Spotify app" link (`spotify:`). iOS does not allow volume control of the iPad's own Spotify app from the API;
the volume slider hides when the device reports `supports_volume: false`.

## Ride-aware features

- **Now** tab: big card (artwork, title, progress, 64-88px controls). Spoken content gets -15s / +30s buttons.
- **Intensity playlists** (Ride tab): map warm-up / endurance / tempo-threshold / VO2 / recovery to playlists.
  Segment type per interval is derived from its power target (% FTP): `<56%` recovery, `56-75%` endurance,
  `76-105%` threshold, `>105%` VO2; easy intervals before the first hard one (first 20 min) are warm-up,
  easy intervals after the last hard one are cool-down; rests shorter than 90s between hard efforts keep the
  hard playlist. Switches happen on `db:intervalIndex` changes and never interrupt podcasts/audiobooks.
- **Auto-pause**: on `watch:paused`, playing podcasts/audiobooks (Spotify or local) are paused and resumed on
  `watch:started`. Music keeps playing.

## Without Spotify (Local tab)

- **RSS feed URL**: fetched in the browser. Many hosts don't send CORS headers, so the fetch fails; the app explains
  and offers: a user-configured CORS proxy (`localStorage['media:cors-proxy']`, template with `{url}`), opening the
  feed `.xml` as a file, or pasting an episode audio URL. Audio playback itself does not need CORS.
- **Audio file** (e.g. `.m4b`/`.mp3` audiobook): played from a blob URL. Resume position is stored in IndexedDB
  (`flux-media` / `positions`) keyed by file name + size, so re-picking the same file resumes.
- Playback speed 1x-2x.

## Events (xf)

Consumes: `db:workout`, `db:ftp`, `db:intervalIndex`, `workout:started|stopped|done`, `watch:paused|started|stopped`.
Emits: `media:auth`, `media:spotify`, `media:local`, `media:segment`, `media:plan`, `media:intensity`, `media:webplayer`, `media:error`.
