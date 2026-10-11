//
// <calendar-settings> — lives inside <section id="calendar-settings"> on the Settings page.
// Touch friendly (>= 44px targets), no hover-only UI.
//

import { xf } from '../../functions.js';
import * as google from './google.js';
import * as calendar from './calendar.js';
import { normalizeWindows } from './scheduler.js';

const STYLE = `
calendar-settings { display: block; color: var(--foreground-color, #fff); }
calendar-settings .cal-group { text-align: left; margin: 1.2em 0; padding: 1em; border: 1px solid var(--border-color, #fff2); border-radius: 0.6em; }
calendar-settings h3 { margin: 0 0 0.6em; font-size: 1.1em; }
calendar-settings label { display: block; margin: 0.6em 0 0.3em; }
calendar-settings input[type=text], calendar-settings input[type=time], calendar-settings input[type=number] {
    min-height: 44px; box-sizing: border-box; font-size: 1em; padding: 0 0.6em; border-radius: 0.4em;
    border: 1px solid var(--border-color, #fff3); background: transparent; color: inherit; }
calendar-settings input[type=text] { width: 100%; }
calendar-settings input[type=number] { width: 6em; }
calendar-settings .cal-row { display: flex; flex-wrap: wrap; gap: 0.6em; align-items: center; }
calendar-settings button { min-height: 44px; min-width: 44px; padding: 0 1em; font-size: 1em; border-radius: 0.4em;
    border: 1px solid var(--border-color, #fff3); background: var(--chrome, #35363a); color: inherit; cursor: pointer; }
calendar-settings button:disabled { opacity: 0.5; }
calendar-settings .cal-check { display: flex; align-items: center; gap: 0.6em; min-height: 44px; margin: 0; }
calendar-settings .cal-check input { width: 24px; height: 24px; }
calendar-settings .cal-status { margin-top: 0.6em; min-height: 1.4em; opacity: 0.9; }
calendar-settings .cal-status[data-state=error] { color: var(--red, #FF495F); }
calendar-settings details summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; }
calendar-settings ol { padding-left: 1.4em; line-height: 1.5; }
calendar-settings code { word-break: break-all; }
`;

function attr(str = '') {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function minutesToTime(m) {
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

class CalendarSettings extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        this.signal = {signal: this.abortController.signal};
        this.render();
        xf.sub('calendar:status', this.onStatus.bind(this), this.signal);
        this.onStatus(calendar.getStatus());
        // preload GIS so the OAuth popup opens directly from the tap (iPad popup blocker)
        if(google.isConfigured()) google.loadGis().catch(() => {});
    }

    disconnectedCallback() {
        this.abortController?.abort();
    }

    $(sel) { return this.querySelector(sel); }

    render() {
        const prefs = calendar.loadPrefs();
        const settings = calendar.loadSettings();
        const win = normalizeWindows(prefs.windows);
        const wd = win[1][0] ?? {start: 360, end: 450};
        const we = win[6][0] ?? {start: 420, end: 660};
        const origin = typeof location !== 'undefined' ? location.origin : '';

        this.innerHTML = `
<style>${STYLE}</style>
<h2 class="page--heading">Calendar</h2>
<p>Plan rides are placed in your free time and added to your calendar, so you just have to ride them.</p>

<div class="cal-group">
  <h3>When can you ride?</h3>
  <label>Weekdays</label>
  <div class="cal-row">
    <input type="time" id="cal-wd-start" value="${minutesToTime(wd.start)}" aria-label="Weekday start">
    <span>to</span>
    <input type="time" id="cal-wd-end" value="${minutesToTime(wd.end)}" aria-label="Weekday end">
  </div>
  <label>Weekends</label>
  <div class="cal-row">
    <input type="time" id="cal-we-start" value="${minutesToTime(we.start)}" aria-label="Weekend start">
    <span>to</span>
    <input type="time" id="cal-we-end" value="${minutesToTime(we.end)}" aria-label="Weekend end">
  </div>
  <label for="cal-rest">Easy days between hard days</label>
  <input type="number" id="cal-rest" min="0" max="3" value="${prefs.minRestDaysBetweenHard ?? 1}">
  <label for="cal-shift">May move a ride by up to (days)</label>
  <input type="number" id="cal-shift" min="0" max="3" value="${prefs.maxShiftDays ?? 1}">
  <label for="cal-reminder">Reminder (minutes before)</label>
  <input type="number" id="cal-reminder" min="0" max="240" value="${settings.reminderMin}">
  <div class="cal-row" style="margin-top:0.8em">
    <button id="cal-save-prefs">Save preferences</button>
  </div>
</div>

<div class="cal-group">
  <h3>Google Calendar</h3>
  <label for="cal-client-id">OAuth Client ID</label>
  <input type="text" id="cal-client-id" autocomplete="off" autocapitalize="off" spellcheck="false"
         placeholder="1234-abc.apps.googleusercontent.com" value="${attr(google.getClientId())}">
  <div class="cal-row" style="margin-top:0.6em">
    <button id="cal-save-client">Save Client ID</button>
  </div>
  <label class="cal-check"><input type="checkbox" id="cal-training" ${settings.trainingCalendar ? 'checked' : ''}>
    Put rides in a separate “Training” calendar</label>
  <label class="cal-check"><input type="checkbox" id="cal-auto" ${settings.autoSync ? 'checked' : ''}>
    Sync automatically when the plan changes</label>
  <div class="cal-row" style="margin-top:0.6em">
    <button id="cal-connect"></button>
    <button id="cal-sync">Sync now</button>
    <button id="cal-unsync">Remove synced events</button>
  </div>
  <div class="cal-status" id="cal-status" role="status" aria-live="polite"></div>

  <details>
    <summary>How to create a Google OAuth Client ID</summary>
    <ol>
      <li>Open <a class="a" href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> and create (or pick) a project.</li>
      <li>APIs &amp; Services → Library → enable <b>Google Calendar API</b>.</li>
      <li>APIs &amp; Services → OAuth consent screen: User type <b>External</b>, fill in app name and your email,
          add scopes <code>calendar.events</code>, <code>calendar.freebusy</code>
          (and <code>calendar.app.created</code> for a separate Training calendar).
          Add yourself under <b>Test users</b> (no Google verification needed while in testing).</li>
      <li>Credentials → Create credentials → <b>OAuth client ID</b> → Application type <b>Web application</b>.</li>
      <li>Authorized JavaScript origins — add every address you open this app from, e.g.:<br>
          <code>http://localhost:1234</code><br>
          <code>${attr(origin || 'https://your-deployed-origin')}</code><br>
          (no path, no trailing slash; redirect URIs are not needed).</li>
      <li>Copy the Client ID (ends in <code>.apps.googleusercontent.com</code>), paste it above and tap Save.</li>
    </ol>
    <p>Tokens stay in this browser only. Testing-mode tokens expire after about an hour; tap Connect again when asked.</p>
  </details>
</div>

<div class="cal-group">
  <h3>Apple Calendar / other apps (no Google account)</h3>
  <p>Exports upcoming planned rides as an .ics file with the times chosen from your preferences.
     On iPad tap “Open in Calendar” and choose “Add All”. Re-export after the plan changes;
     events update in place.</p>
  <div class="cal-row">
    <button id="cal-ics-open">Open in Calendar</button>
    <button id="cal-ics-download">Download .ics</button>
  </div>
</div>
`;
        this.$('#cal-save-prefs').addEventListener('click', this.onSavePrefs.bind(this), this.signal);
        this.$('#cal-save-client').addEventListener('click', this.onSaveClient.bind(this), this.signal);
        this.$('#cal-connect').addEventListener('click', this.onConnect.bind(this), this.signal);
        this.$('#cal-sync').addEventListener('click', () => calendar.syncAll({interactive: true}), this.signal);
        this.$('#cal-unsync').addEventListener('click', this.onUnsync.bind(this), this.signal);
        this.$('#cal-training').addEventListener('change', this.onSettings.bind(this), this.signal);
        this.$('#cal-auto').addEventListener('change', this.onSettings.bind(this), this.signal);
        this.$('#cal-ics-open').addEventListener('click', () => calendar.exportIcs({open: true}), this.signal);
        this.$('#cal-ics-download').addEventListener('click', () => calendar.exportIcs({open: false}), this.signal);
        this.updateButtons();
    }

    updateButtons() {
        const configured = google.isConfigured();
        const connected = google.isConnected();
        this.$('#cal-connect').textContent = connected ? 'Disconnect Google' : 'Connect Google';
        this.$('#cal-connect').disabled = !configured;
        this.$('#cal-sync').disabled = !configured;
        this.$('#cal-unsync').disabled = !connected;
    }

    onStatus(s = {}) {
        const el = this.$('#cal-status');
        if(!el) return;
        el.dataset.state = s.state ?? 'idle';
        el.textContent = s.message ?? '';
        this.updateButtons();
    }

    onSavePrefs() {
        const prefs = calendar.loadPrefs();
        prefs.windows = {
            weekday: [{start: this.$('#cal-wd-start').value, end: this.$('#cal-wd-end').value}],
            weekend: [{start: this.$('#cal-we-start').value, end: this.$('#cal-we-end').value}],
        };
        prefs.minRestDaysBetweenHard = Math.max(0, Number(this.$('#cal-rest').value) || 0);
        prefs.maxShiftDays = Math.max(0, Number(this.$('#cal-shift').value) || 0);
        calendar.savePrefs(prefs);
        const settings = calendar.loadSettings();
        settings.reminderMin = Math.max(0, Number(this.$('#cal-reminder').value) || 0);
        calendar.saveSettings(settings);
        this.onStatus({state: 'idle', message: 'Preferences saved'});
    }

    onSaveClient() {
        google.setClientId(this.$('#cal-client-id').value);
        if(google.isConfigured()) {
            google.loadGis().catch(() => {});
            this.onStatus({state: 'idle', message: 'Client ID saved. Tap “Connect Google”.'});
        } else {
            this.onStatus({state: 'error', message: 'That does not look like a Client ID (…apps.googleusercontent.com)'});
        }
    }

    onSettings() {
        const settings = calendar.loadSettings();
        const before = settings.trainingCalendar;
        settings.trainingCalendar = this.$('#cal-training').checked;
        settings.autoSync = this.$('#cal-auto').checked;
        calendar.saveSettings(settings);
        // a different scope set needs a new consent
        if(before !== settings.trainingCalendar && google.isConnected()) {
            calendar.disconnect();
        }
        this.updateButtons();
    }

    async onConnect() {
        if(google.isConnected()) {
            calendar.disconnect();
        } else if(await calendar.connect()) {
            calendar.syncAll({interactive: false});
        }
        this.updateButtons();
    }

    async onUnsync() {
        if(!window.confirm('Remove all training events this app created in Google Calendar?')) return;
        try {
            await calendar.unsyncAll();
        } catch (err) {
            this.onStatus({state: 'error', message: err.message});
        }
    }
}

if(!customElements.get('calendar-settings')) {
    customElements.define('calendar-settings', CalendarSettings);
}

export { CalendarSettings };
