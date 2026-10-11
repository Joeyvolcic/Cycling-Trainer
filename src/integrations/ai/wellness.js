// Wellness / recovery data for the readiness check.
//
// Contract (doc/integrations-contract.md):
//   async getWellness(date) ->
//     {sleepScore?, sleepHours?, hrv?, restingHR?, readiness?, source}
//
// Sources, in order:
//   1. intervals.icu wellness (aggregates Garmin / Oura / Whoop / etc.)
//      a. direct API key (Settings → AI Coach), Basic auth to intervals.icu
//      b. the existing OAuth connection via the Auuki API proxy (best effort)
//   2. manual entry for the day (augments / overrides 1.)
//
// Extra fields returned when known: sleepQuality, soreness, fatigue, stress,
// mood, motivation, feel (all on 1–5 scales, see SCALES), notes, ctl, atl,
// tsb, rampRate, avgSleepingHR, spO2, hrvBaseline, restingHRBaseline.
import config from '../../models/config.js';

const INTERVALS_KEY_STORAGE     = 'ai:intervals-key';
const INTERVALS_ATHLETE_STORAGE = 'ai:intervals-athlete';
const MANUAL_PREFIX             = 'ai:wellness:';
const INTERVALS_BASE            = 'https://intervals.icu/api/v1';

// Subjective scales used everywhere in this module (and in the prompt):
//   sleepQuality, feel, mood, motivation: 1 (worst) .. 5 (best)
//   soreness, fatigue, stress:            1 (none)  .. 5 (extreme)
const SCALES = Object.freeze({
    higherIsBetter: ['sleepQuality', 'feel', 'mood', 'motivation'],
    higherIsWorse:  ['soreness', 'fatigue', 'stress'],
});

// intervals.icu uses 1..4 where 1 is the "good" end for sleepQuality
// (Great, Good, Avg, Poor), mood (Great .. Grumpy) and motivation
// (Extreme .. Low); and 1 is the "low" end for soreness, fatigue, stress.
const icuBestFirst = {1: 5, 2: 4, 3: 3, 4: 1};
const icuLowFirst  = {1: 1, 2: 2, 3: 4, 4: 5};

function storage() {
    try { return globalThis.localStorage; } catch(e) { return undefined; }
}

function num(x) {
    if(x === null || x === undefined || x === '') return undefined;
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
}

function round(x, digits = 1) {
    if(x === undefined) return undefined;
    const f = 10 ** digits;
    return Math.round(x * f) / f;
}

function clamp(x, min, max) {
    if(x === undefined) return undefined;
    return Math.min(max, Math.max(min, x));
}

function compact(obj) {
    return Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined && v !== null && v !== '')
    );
}

function isoDate(date = new Date()) {
    const d = (date instanceof Date) ? date : new Date(date);
    const day   = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}

function addDays(dateString, days) {
    const [y, m, d] = dateString.split('-').map(Number);
    return isoDate(new Date(y, m - 1, d + days));
}

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

function getIntervalsKey() {
    return (storage()?.getItem(INTERVALS_KEY_STORAGE) ?? '').trim();
}

function getIntervalsAthleteId() {
    return (storage()?.getItem(INTERVALS_ATHLETE_STORAGE) ?? '').trim() || '0';
}

function setIntervalsKey(key = '', athleteId = '') {
    const value = String(key).trim();
    if(value === '') {
        storage()?.removeItem(INTERVALS_KEY_STORAGE);
        storage()?.removeItem(INTERVALS_ATHLETE_STORAGE);
        return;
    }
    storage()?.setItem(INTERVALS_KEY_STORAGE, value);
    const athlete = String(athleteId).trim();
    if(athlete) {
        storage()?.setItem(INTERVALS_ATHLETE_STORAGE, athlete);
    } else {
        storage()?.removeItem(INTERVALS_ATHLETE_STORAGE);
    }
}

// ----------------------------------------------------------------------------
// Normalization
// ----------------------------------------------------------------------------

// intervals.icu wellness record -> normalized wellness (no source)
function normalizeIntervalsWellness(rec = {}) {
    const sleepSecs = num(rec.sleepSecs);
    const ctl = num(rec.ctl);
    const atl = num(rec.atl);

    return compact({
        date:          rec.id,
        sleepScore:    num(rec.sleepScore),
        sleepHours:    sleepSecs !== undefined ? round(sleepSecs / 3600, 1) : undefined,
        sleepQuality:  icuBestFirst[num(rec.sleepQuality)],
        hrv:           num(rec.hrv) ?? num(rec.hrvSDNN),
        restingHR:     num(rec.restingHR),
        avgSleepingHR: num(rec.avgSleepingHR),
        readiness:     num(rec.readiness),
        spO2:          num(rec.spO2),
        soreness:      icuLowFirst[num(rec.soreness)],
        fatigue:       icuLowFirst[num(rec.fatigue)],
        stress:        icuLowFirst[num(rec.stress)],
        mood:          icuBestFirst[num(rec.mood)],
        motivation:    icuBestFirst[num(rec.motivation)],
        ctl:           round(ctl, 1),
        atl:           round(atl, 1),
        tsb:           (ctl !== undefined && atl !== undefined) ? round(ctl - atl, 1) : undefined,
        rampRate:      round(num(rec.rampRate), 1),
        notes:         rec.comments || undefined,
    });
}

// manual form -> normalized wellness (no source); clamps to valid ranges
function normalizeManual(entry = {}) {
    const scale = (x) => {
        const n = num(x);
        return n === undefined ? undefined : Math.round(clamp(n, 1, 5));
    };
    return compact({
        sleepHours:   round(clamp(num(entry.sleepHours), 0, 24), 1),
        sleepQuality: scale(entry.sleepQuality),
        soreness:     scale(entry.soreness),
        stress:       scale(entry.stress),
        fatigue:      scale(entry.fatigue),
        feel:         scale(entry.feel),
        notes:        typeof entry.notes === 'string' ? entry.notes.trim().slice(0, 500) : undefined,
    });
}

function mean(xs) {
    const ys = xs.filter((x) => x !== undefined);
    if(ys.length === 0) return undefined;
    return ys.reduce((a, b) => a + b, 0) / ys.length;
}

// [intervals.icu records] -> normalized record for `date` with 7-day baselines
function fromIntervalsHistory(records = [], date) {
    const list = Array.isArray(records) ? records : [records];
    const today = list.find((r) => r?.id === date);
    const before = list.filter((r) => r?.id && r.id < date).map(normalizeIntervalsWellness);

    if(!today && before.length === 0) return undefined;

    const result = today ? normalizeIntervalsWellness(today) : {};
    return compact(Object.assign(result, {
        hrvBaseline:       round(mean(before.map((r) => r.hrv)), 1),
        restingHRBaseline: round(mean(before.map((r) => r.restingHR)), 1),
        sleepHoursAvg:     round(mean(before.map((r) => r.sleepHours)), 1),
    }));
}

// intervals.icu (may be undefined) + manual (may be undefined) -> contract shape
function mergeWellness(icu, manual) {
    const hasIcu = icu && Object.keys(icu).length > 0;
    const hasManual = manual && Object.keys(manual).length > 0;

    const source = [hasIcu ? 'intervals.icu' : null, hasManual ? 'manual' : null]
        .filter(Boolean).join('+') || 'none';

    // manual entry wins on overlapping subjective fields: the rider knows best
    return Object.assign({}, hasIcu ? icu : {}, hasManual ? manual : {}, {source});
}

// ----------------------------------------------------------------------------
// Manual entry (per day, this device only)
// ----------------------------------------------------------------------------

function getManualWellness(date = isoDate()) {
    try {
        const raw = storage()?.getItem(MANUAL_PREFIX + date);
        return raw ? normalizeManual(JSON.parse(raw)) : undefined;
    } catch(e) {
        return undefined;
    }
}

function saveManualWellness(date = isoDate(), entry = {}) {
    const value = normalizeManual(entry);
    storage()?.setItem(MANUAL_PREFIX + date, JSON.stringify(value));
    pruneManual();
    return value;
}

function clearManualWellness(date = isoDate()) {
    storage()?.removeItem(MANUAL_PREFIX + date);
}

// keep ~30 days of manual entries
function pruneManual(keepDays = 30) {
    const s = storage();
    if(!s) return;
    const oldest = addDays(isoDate(), -keepDays);
    const keys = [];
    for(let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if(k && k.startsWith(MANUAL_PREFIX) && k.slice(MANUAL_PREFIX.length) < oldest) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
}

// ----------------------------------------------------------------------------
// intervals.icu transport
// ----------------------------------------------------------------------------

function basicAuth(key) {
    return `Basic ${btoa(`API_KEY:${key}`)}`;
}

// GET from intervals.icu. Uses the direct API key when set, otherwise tries the
// Auuki OAuth proxy (POST {proxy}/api/intervals/{proxyPath}). Returns parsed
// JSON or undefined; never throws (wellness is optional context).
async function intervalsGet(path, query = {}, proxyPath) {
    const key = getIntervalsKey();
    const qs = new URLSearchParams(query).toString();

    try {
        if(key) {
            const athlete = encodeURIComponent(getIntervalsAthleteId());
            const url = `${INTERVALS_BASE}/athlete/${athlete}/${path}${qs ? '?' + qs : ''}`;
            const res = await fetch(url, {
                headers: { Authorization: basicAuth(key), Accept: 'application/json' },
            });
            if(!res.ok) {
                console.warn(`:ai :wellness :intervals ${res.status} ${path}`);
                return undefined;
            }
            return await res.json();
        }
        if(proxyPath) {
            // OAuth path: same pattern as src/models/intervals.js (cookie session)
            const url = `${config.get().API_URI}/api/intervals/${proxyPath}${qs ? '?' + qs : ''}`;
            const res = await fetch(url, { method: 'POST', credentials: 'include' });
            if(!res.ok) return undefined;
            return await res.json();
        }
    } catch(e) {
        console.warn(`:ai :wellness :intervals :error ${path}`, e);
    }
    return undefined;
}

async function getIntervalsWellness(date) {
    const records = await intervalsGet(
        'wellness',
        { oldest: addDays(date, -7), newest: date },
        'wellness',
    );
    if(!records) return undefined;
    return fromIntervalsHistory(records, date);
}

// ----------------------------------------------------------------------------
// Public
// ----------------------------------------------------------------------------

async function getWellness(date = isoDate()) {
    const [icu, manual] = await Promise.all([
        getIntervalsWellness(date),
        Promise.resolve(getManualWellness(date)),
    ]);
    return mergeWellness(icu, manual);
}

// intervals.icu activity -> compact summary for the prompt
function normalizeIntervalsActivity(a = {}) {
    const secs = num(a.moving_time) ?? num(a.elapsed_time);
    return compact({
        date:      (a.start_date_local ?? '').slice(0, 10) || undefined,
        name:      a.name,
        type:      a.type,
        minutes:   secs !== undefined ? Math.round(secs / 60) : undefined,
        load:      num(a.icu_training_load),
        intensity: round(num(a.icu_intensity), 0),
        np:        num(a.icu_weighted_avg_watts),
        avgPower:  num(a.icu_average_watts),
        avgHR:     num(a.average_heartrate),
        rpe:       num(a.icu_rpe),
    });
}

// local Auuki activity summaries ({timestamp, duration(s), name}) -> same shape
function normalizeLocalActivity(s = {}) {
    return compact({
        date:    s.timestamp ? isoDate(new Date(s.timestamp)) : undefined,
        name:    s.name,
        type:    'VirtualRide',
        minutes: num(s.duration) !== undefined ? Math.round(num(s.duration) / 60) : undefined,
    });
}

function summarizeLoad(activities = [], date, days = 14) {
    const sum = (xs, f) => xs.reduce((acc, x) => acc + (f(x) ?? 0), 0);
    const since = (n) => activities.filter((a) => a.date && a.date >= addDays(date, -n) && a.date < date);

    const last3 = since(3);
    const last7 = since(7);
    const lastDay = activities
        .filter((a) => a.date && a.date < date)
        .map((a) => a.date)
        .sort()
        .pop();

    return compact({
        days,
        activities,
        count7d:        last7.length,
        minutes7d:      sum(last7, (a) => a.minutes),
        load7d:         last7.some((a) => a.load !== undefined) ? sum(last7, (a) => a.load) : undefined,
        load3d:         last3.some((a) => a.load !== undefined) ? sum(last3, (a) => a.load) : undefined,
        minutes3d:      sum(last3, (a) => a.minutes),
        lastActivityDate: lastDay,
    });
}

// Recent training load: intervals.icu activities when available, otherwise
// the activities recorded locally in this app (passed in by the caller).
async function getRecentLoad(date = isoDate(), {days = 14, localActivities = []} = {}) {
    const remote = await intervalsGet(
        'activities',
        { oldest: addDays(date, -days), newest: addDays(date, -1) },
        'activities',
    );

    let activities;
    let source;
    if(Array.isArray(remote)) {
        activities = remote.map(normalizeIntervalsActivity);
        source = 'intervals.icu';
    } else {
        const oldest = addDays(date, -days);
        activities = (localActivities ?? [])
            .map(normalizeLocalActivity)
            .filter((a) => a.date && a.date >= oldest && a.date < date);
        source = 'local';
    }

    activities.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return Object.assign(summarizeLoad(activities, date, days), {source});
}

// Planned workouts for a date straight from intervals.icu (direct API key
// only; the OAuth path already feeds models.planned). Returns raw events that
// carry workout_file_base64 (.zwo) when intervals.icu can export them.
async function getIntervalsPlanned(date = isoDate()) {
    if(!getIntervalsKey()) return [];
    const events = await intervalsGet('events', {
        oldest: date, newest: date, category: 'WORKOUT', ext: 'zwo',
    });
    return Array.isArray(events) ? events.filter((e) => e.workout_file_base64) : [];
}

export {
    getWellness,

    getRecentLoad,
    getIntervalsPlanned,
    getManualWellness,
    saveManualWellness,
    clearManualWellness,
    getIntervalsKey,
    getIntervalsAthleteId,
    setIntervalsKey,

    normalizeIntervalsWellness,
    normalizeIntervalsActivity,
    normalizeLocalActivity,
    normalizeManual,
    fromIntervalsHistory,
    mergeWellness,
    summarizeLoad,
    addDays,
    isoDate,
    SCALES,
};
