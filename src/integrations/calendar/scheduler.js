//
// Calendar scheduler (pure, no DOM / network).
//
// Given training plan entries (see doc/integrations-contract.md), the rider's
// preferences and a list of busy intervals, choose a concrete time slot for
// each entry. All wall-clock reasoning is done in the local time zone.
//

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND  = [0, 6];

const DEFAULT_PREFS = Object.freeze({
    // key: weekday (0 = Sunday ... 6 = Saturday), value: list of windows
    windows: {
        weekday: [{start: '06:00', end: '07:30'}],
        weekend: [{start: '07:00', end: '11:00'}],
    },
    minRestDaysBetweenHard: 1, // at least N easy/rest days between two hard days
    maxShiftDays: 1,           // may move an entry +/- N days when its date has no slot
    maxPerDay: 1,              // max rides placed on the same day
    bufferMin: 10,             // keep this gap to busy intervals
    stepMin: 15,               // granularity of candidate start times
    defaultDurationMin: 60,
    honorTargetTime: true,     // entry.targetTime wins when it is free
});

// --- small date helpers ---------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }

function parseDate(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, m - 1, d);
}

function formatDate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseTime(str) {
    const [h, m] = String(str).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function at(day, minutes) {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
}

function dayDiff(a, b) {
    // calendar-day difference, DST safe
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ua - ub) / DAY_MS);
}

function toDate(x) {
    return x instanceof Date ? x : new Date(x);
}

// --- prefs ------------------------------------------------------------------

function normalizeWindows(windows = {}) {
    const out = {0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: []};
    const add = (days, list) => days.forEach(d => { out[d] = out[d].concat(list ?? []); });

    // explicit per-weekday keys override weekday/weekend shorthands
    const explicit = new Set();
    for(const k of Object.keys(windows)) {
        if(/^[0-6]$/.test(k)) explicit.add(Number(k));
    }
    if(windows.weekday) add(WEEKDAYS.filter(d => !explicit.has(d)), windows.weekday);
    if(windows.weekend) add(WEEKEND.filter(d => !explicit.has(d)), windows.weekend);
    explicit.forEach(d => add([d], windows[d]));

    for(const d of Object.keys(out)) {
        out[d] = out[d]
            .map(w => ({start: parseTime(w.start), end: parseTime(w.end)}))
            .filter(w => w.end > w.start)
            .sort((a, b) => a.start - b.start);
    }
    return out;
}

function normalizePrefs(prefs = {}) {
    const merged = Object.assign({}, DEFAULT_PREFS, prefs ?? {});
    merged.windows = normalizeWindows(prefs?.windows ?? DEFAULT_PREFS.windows);
    return merged;
}

// --- intensity --------------------------------------------------------------

const HARD_RE = /\b(vo2|vo2max|threshold|sweet ?spot|ftp|intervals?|over[- ]?unders?|anaerobic|sprints?|race|racing|hard|max|attacks?|crit|hill repeats?|ramp|test)\b/i;
const EASY_RE = /\b(recovery|easy|endurance|z1|z2|zone ?[12]|spin|rest|openers?)\b/i;

function isHardEntry(entry = {}) {
    if(typeof entry.hard === 'boolean') return entry.hard;
    if(entry.intensity) return /^(hard|high|very hard|max)$/i.test(entry.intensity);
    const text = `${entry.workoutName ?? ''} ${entry.notes ?? ''}`;
    if(EASY_RE.test(text) && !HARD_RE.test(entry.workoutName ?? '')) return false;
    return HARD_RE.test(text);
}

// --- core -------------------------------------------------------------------

function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

function shiftOrder(maxShift) {
    const out = [0];
    for(let i = 1; i <= maxShift; i++) out.push(i, -i);
    return out;
}

/**
 * Choose a slot for each plan entry.
 *
 * @param {Array} entries  contract TrainingPlan entries
 * @param {Object} prefs   see DEFAULT_PREFS (windows may use weekday/weekend
 *                         shorthands or keys '0'..'6')
 * @param {Object} options
 *   busy:  [{start, end}] Date | ISO string, e.g. Google freebusy result
 *   now:   Date, slots before it are never chosen (default: new Date())
 *   fixed: [{start, end, hard}] rides already on the calendar that count for
 *          maxPerDay / hard-day rest but are not moved
 * @returns {Array} one result per entry, in input order:
 *   {entryId, entry, date, start, end, time, shiftedDays, hard, warnings, reason?}
 *   start/end are Date (null when no slot could be found, see `reason`).
 */
function scheduleEntries(entries = [], prefs = {}, options = {}) {
    const p     = normalizePrefs(prefs);
    const now   = options.now ? toDate(options.now) : new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const buffer = p.bufferMin * 60 * 1000;

    const busy = (options.busy ?? []).map(b => ({start: toDate(b.start), end: toDate(b.end)}));
    const placed = (options.fixed ?? []).map(f => ({
        start: toDate(f.start), end: toDate(f.end), hard: !!f.hard,
    }));
    busy.push(...placed.map(f => ({start: f.start, end: f.end})));

    const isFree = (start, end) =>
        start >= now &&
        !busy.some(b => overlaps(start.getTime() - buffer, end.getTime() + buffer,
                                 b.start.getTime(), b.end.getTime()));

    const countOn = (day) => placed.filter(x => dayDiff(x.start, day) === 0).length;

    const restOk = (day) => !placed.some(x =>
        x.hard && Math.abs(dayDiff(x.start, day)) <= p.minRestDaysBetweenHard);

    function findOnDay(day, entry, durMin, useTarget) {
        if(useTarget && entry.targetTime && p.honorTargetTime) {
            const start = at(day, parseTime(entry.targetTime));
            const end = new Date(start.getTime() + durMin * 60000);
            if(isFree(start, end)) return {start, end};
        }
        for(const w of p.windows[day.getDay()] ?? []) {
            for(let m = w.start; m + durMin <= w.end; m += p.stepMin) {
                const start = at(day, m);
                const end = new Date(start.getTime() + durMin * 60000);
                if(isFree(start, end)) return {start, end};
            }
        }
        return null;
    }

    // process in date order (hard first on the same day), report in input order
    const order = entries
        .map((entry, i) => ({entry, i, hard: isHardEntry(entry)}))
        .sort((a, b) => (a.entry.date ?? '').localeCompare(b.entry.date ?? '') ||
                        (b.hard - a.hard) || (a.i - b.i));

    const results = new Array(entries.length);

    for(const {entry, i, hard} of order) {
        const durMin = Number(entry.durationMin) > 0 ? Number(entry.durationMin) : p.defaultDurationMin;
        const base = parseDate(entry.date);
        const offsets = shiftOrder(Math.max(0, p.maxShiftDays | 0));
        let found = null;
        const warnings = [];

        // pass 0: respect hard-day rest; pass 1: relax it (and warn)
        for(let pass = 0; pass < 2 && !found; pass++) {
            for(const off of offsets) {
                const day = addDays(base, off);
                if(dayDiff(day, today) < 0) continue;
                if(countOn(day) >= p.maxPerDay) continue;
                if(hard && pass === 0 && !restOk(day)) continue;
                const slot = findOnDay(day, entry, durMin, off === 0);
                if(slot) {
                    found = {...slot, off};
                    if(pass === 1) warnings.push('rest-violation');
                    break;
                }
            }
        }

        if(found) {
            placed.push({start: found.start, end: found.end, hard});
            busy.push({start: found.start, end: found.end});
            if(found.off !== 0) warnings.push('shifted');
            results[i] = {
                entryId: entry.id, entry, hard, warnings,
                date: formatDate(found.start),
                time: formatTime(found.start),
                start: found.start,
                end: found.end,
                shiftedDays: found.off,
            };
        } else {
            results[i] = {
                entryId: entry.id, entry, hard, warnings,
                date: entry.date, time: null, start: null, end: null, shiftedDays: 0,
                reason: dayDiff(addDays(base, p.maxShiftDays | 0), today) < 0 ? 'in-past' : 'no-free-slot',
            };
        }
    }
    return results;
}

export {
    DEFAULT_PREFS,
    normalizePrefs,
    normalizeWindows,
    isHardEntry,
    scheduleEntries,
    parseDate,
    formatDate,
    formatTime,
    addDays,
    dayDiff,
};
