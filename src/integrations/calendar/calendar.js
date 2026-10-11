//
// Calendar integration — public API.
//
//   scheduleEntries(entries, prefs?, options?)  -> Promise<results>   (for the AI agent)
//   syncAll({interactive})                       -> Promise<report[]>  (Google Calendar)
//   exportIcs({download})                        -> string             (.ics fallback)
//   loadPrefs() / savePrefs(prefs), loadSettings() / saveSettings(s)
//
// xf events:
//   in:  plans:changed (auto-sync), db:workouts (workout summaries), app:deeplink
//   out: calendar:status {state, message, report?}
//

import { xf } from '../../functions.js';
import * as plans from '../plans/plans.js';
import * as google from './google.js';
import { syncPlan, unsyncPlan } from './sync.js';
import { toIcs } from './ics.js';
import {
    DEFAULT_PREFS, scheduleEntries as scheduleCore, formatDate, addDays,
} from './scheduler.js';

const PREFS_KEY = 'calendar:prefs';
const SETTINGS_KEY = 'calendar:settings';

const DEFAULT_SETTINGS = Object.freeze({
    trainingCalendar: false, // use a dedicated "Training" calendar
    autoSync: true,          // sync when the plan changes and a token is available
    horizonDays: 28,
    reminderMin: 15,
});

function readJson(key, fallback) {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback);
    } catch (_) {
        return Object.assign({}, fallback);
    }
}
function writeJson(key, value) {
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function loadPrefs() { return readJson(PREFS_KEY, DEFAULT_PREFS); }
function savePrefs(prefs) { writeJson(PREFS_KEY, prefs); }
function loadSettings() { return readJson(SETTINGS_KEY, DEFAULT_SETTINGS); }
function saveSettings(s) { writeJson(SETTINGS_KEY, s); }

// --- workout summaries for event descriptions ------------------------------

let workouts = [];
xf.sub('db:workouts', (list) => { if(Array.isArray(list)) workouts = list; });

function findWorkout(id) {
    if(id === undefined || id === null) return undefined;
    return workouts.find(w => String(w.id) === String(id));
}

function describe(entry) {
    const meta = findWorkout(entry.workoutId)?.meta;
    if(!meta) return '';
    const parts = [];
    if(meta.category) parts.push(meta.category);
    if(meta.description) parts.push(String(meta.description).trim());
    return parts.join(' — ');
}

// --- status ----------------------------------------------------------------

let lastStatus = {state: 'idle', message: ''};
function status(state, message = '', extra = {}) {
    lastStatus = {state, message, ...extra};
    xf.dispatch('calendar:status', lastStatus);
}
function getStatus() { return lastStatus; }

// --- scheduling (AI-facing) ------------------------------------------------

/**
 * Place entries on the calendar grid without writing anything.
 * Uses saved prefs merged with `prefs`; when Google is connected (valid token)
 * and no `options.busy` is given, the rider's free/busy is consulted.
 * Resolves to scheduler results: [{entryId, date, time, start, end, warnings, reason?}]
 */
async function scheduleEntries(entries = [], prefs = {}, options = {}) {
    const merged = Object.assign({}, loadPrefs(), prefs);
    let busy = options.busy;
    if(!busy && google.isConfigured() && google.isConnected() && entries.length) {
        try {
            const dates = entries.map(e => e.date).sort();
            const shift = merged.maxShiftDays ?? 1;
            const client = google.GoogleCalendarClient({tokenOpts: tokenOpts()});
            busy = await client.freeBusy({
                timeMin: addDays(new Date(`${dates[0]}T00:00`), -shift),
                timeMax: addDays(new Date(`${dates[dates.length - 1]}T00:00`), shift + 1),
                calendarIds: busyCalendars(),
            });
        } catch (err) {
            console.warn(':calendar :freebusy failed, scheduling without it', err);
        }
    }
    return scheduleCore(entries, merged, Object.assign({}, options, {busy: busy ?? []}));
}

// --- Google sync -----------------------------------------------------------

function tokenOpts() {
    return {trainingCalendar: !!loadSettings().trainingCalendar};
}

function busyCalendars() {
    const s = loadSettings();
    const ids = ['primary'];
    const training = globalThis.localStorage?.getItem(google.KEYS.trainingId);
    if(s.trainingCalendar && training) ids.push(training);
    return ids;
}

let syncing = false;

async function connect() {
    status('connecting', 'Waiting for Google sign-in…');
    try {
        await google.requestToken(Object.assign({prompt: ''}, tokenOpts()));
        status('connected', 'Connected to Google Calendar');
        return true;
    } catch (err) {
        status('error', err.message);
        return false;
    }
}

function disconnect() {
    google.disconnect();
    status('idle', 'Disconnected');
}

async function syncAll({interactive = false} = {}) {
    if(syncing) return [];
    if(!google.isConfigured()) {
        status('error', 'Set your Google OAuth Client ID first');
        return [];
    }
    if(!google.isConnected() && !interactive) {
        status('needs-connect', 'Tap “Connect Google” to sync');
        return [];
    }
    syncing = true;
    status('syncing', 'Syncing plan to Google Calendar…');
    try {
        const settings = loadSettings();
        const client = google.GoogleCalendarClient({tokenOpts: tokenOpts()});
        const calendarId = settings.trainingCalendar
            ? await client.ensureCalendar('Training')
            : 'primary';
        const reports = [];
        for(const plan of await plans.listPlans()) {
            reports.push(await syncPlan(plan, {
                client,
                prefs: loadPrefs(),
                updateEntry: plans.updateEntry,
                calendarId,
                busyCalendarIds: busyCalendars(),
                horizonDays: Number(settings.horizonDays) || 28,
                reminderMin: Number(settings.reminderMin) || 0,
                describe,
            }));
        }
        const sum = (k) => reports.reduce((a, r) => a + r[k].length, 0);
        const msg = `Synced: ${sum('created')} new, ${sum('moved')} moved, ` +
                    `${sum('updated')} updated, ${sum('deleted')} removed` +
                    (sum('unscheduled') ? `, ${sum('unscheduled')} without a free slot` : '') +
                    (sum('errors') ? `, ${sum('errors')} errors` : '');
        status(sum('errors') ? 'error' : 'synced', msg, {reports, at: new Date().toISOString()});
        return reports;
    } catch (err) {
        console.error(':calendar :sync', err);
        status('error', err.message);
        return [];
    } finally {
        syncing = false;
    }
}

async function unsyncAll() {
    const settings = loadSettings();
    const client = google.GoogleCalendarClient({tokenOpts: tokenOpts()});
    const calendarId = settings.trainingCalendar
        ? (globalThis.localStorage?.getItem(google.KEYS.trainingId) ?? 'primary')
        : 'primary';
    let n = 0;
    for(const plan of await plans.listPlans()) {
        n += await unsyncPlan(plan, {client, calendarId, updateEntry: plans.updateEntry});
    }
    status('idle', `Removed ${n} events`);
    return n;
}

let autoTimer;
xf.sub('plans:changed', () => {
    if(syncing) return;
    const s = loadSettings();
    if(!s.autoSync || !google.isConfigured() || !google.isConnected()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => syncAll({interactive: false}), 2000);
});

// --- .ics fallback ---------------------------------------------------------

async function buildIcs({now = new Date()} = {}) {
    const settings = loadSettings();
    const today = formatDate(now);
    const end = formatDate(addDays(now, Number(settings.horizonDays) || 28));
    const items = [];
    for(const plan of await plans.listPlans()) {
        const entries = (plan.entries ?? []).filter(e =>
            (e.status ?? 'planned') === 'planned' && e.date >= today && e.date <= end);
        // place them with the rider's windows (no free/busy without OAuth)
        const results = scheduleCore(entries, loadPrefs(), {now, busy: []});
        for(const r of results) {
            items.push({
                entry: r.start ? {...r.entry, date: r.date} : r.entry,
                planId: plan.id, planName: plan.name,
                start: r.start, end: r.end, summary: describe(r.entry),
            });
        }
    }
    return {
        text: toIcs(items, {now, reminderMin: Number(settings.reminderMin) || 0}),
        count: items.length,
    };
}

async function exportIcs({open = false} = {}) {
    const {text, count} = await buildIcs();
    const blob = new Blob([text], {type: 'text/calendar;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    if(open) {
        // iPad Safari: navigating to a text/calendar resource offers "Add to Calendar"
        window.location.href = url;
    } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = 'training-plan.ics';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return count;
}

// --- deep links: ?workout=<id> / ?planEntry=<id>&plan=<id> -----------------

async function openFromLink({workout, planEntry, plan} = {}) {
    let workoutId = workout;
    if(planEntry && (workoutId === undefined || workoutId === null)) {
        const list = plan ? [await plans.getPlan(plan)] : await plans.listPlans();
        for(const p of list.filter(Boolean)) {
            const e = (p.entries ?? []).find(e => String(e.id) === String(planEntry));
            if(e) { workoutId = e.workoutId; break; }
        }
    }
    if(workoutId !== undefined && workoutId !== null && findWorkout(workoutId)) {
        xf.dispatch('ui:workout:select', findWorkout(workoutId).id);
    } else if(workoutId) {
        console.warn(`:calendar :deeplink workout '${workoutId}' not found`);
    }
    xf.dispatch('ui:page-set', 'home');
    xf.dispatch('calendar:opened-entry', {planId: plan, entryId: planEntry, workoutId});
}

xf.sub('app:deeplink', (params) => { openFromLink(params); });

export {
    scheduleEntries,
    syncAll,
    unsyncAll,
    connect,
    disconnect,
    exportIcs,
    buildIcs,
    loadPrefs, savePrefs, loadSettings, saveSettings,
    getStatus,
    openFromLink,
    DEFAULT_SETTINGS,
};
