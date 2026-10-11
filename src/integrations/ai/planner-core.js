// AI plan builder + coach-feedback plan changes: the deterministic core.
//
// Claude only *chooses*: which library workout goes on which date, or (when
// nothing fits) a short list of typed steps; and which change to make to an
// upcoming plan entry. Everything that ends up in the plan is produced and
// validated here, in plain JS, with every number clamped. Nothing free-form
// from the model is trusted.
//
// No network, no DOM: orchestration lives in ./planner.js, views in
// ./planner-view.js.

import {
    workoutMetrics, workoutDuration, describeStructure,
    sanitizeDecision, applyDecision, LIMITS,
} from './adjust.js';
import {
    addDays, diffDays, weekStart, workoutSnapshot, resolveWorkout,
} from '../plans/plans.js';
import { normalizePrefs } from '../calendar/scheduler.js';

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HARD_IF = 0.85;

function clone(x) {
    return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

function clamp(x, min, max) {
    return Math.min(max, Math.max(min, x));
}

function round(x, digits = 0) {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
}

function num(x, fallback = NaN) {
    if(x === null || x === undefined || x === '') return fallback;
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

// plain single-line text, no control chars, bounded length
function text(x, max = 200) {
    if(x === null || x === undefined) return '';
    return String(x).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isISODate(x) {
    if(typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
    const [y, m, d] = x.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

function weekdayOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
}

function newId(prefix = 'ai') {
    try {
        if(globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    } catch(e) {}
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isHardWorkout(metrics) {
    return (metrics?.if ?? 0) >= HARD_IF;
}

// ----------------------------------------------------------------------------
// Workout catalog (what Claude may choose from)
// ----------------------------------------------------------------------------

// workouts: db.workouts (built-in + custom). Built-in ids are regenerated on
// every load, so Claude sees short refs (w1, w2…) and we map them back here;
// the plan stores a snapshot, so later id churn does not matter.
function buildCatalog(workouts = [], {limit = 150} = {}) {
    const catalog = [];
    const byRef = new Map();
    const seen = new Set();
    for(const w of workouts ?? []) {
        if(catalog.length >= limit) break;
        if(!w || !Array.isArray(w.intervals) || w.intervals.length === 0) continue;
        // skip one-off AI copies and intervals.icu planned events
        if(w.meta?.adjustedFrom || w.meta?.planned || w.meta?.aiGenerated) continue;
        const name = text(w.meta?.name, 60);
        if(!name || seen.has(name.toLowerCase())) continue;
        const m = workoutMetrics(w);
        if(!(m.minutes > 0)) continue;
        seen.add(name.toLowerCase());
        const ref = `w${catalog.length + 1}`;
        catalog.push({
            ref,
            name,
            category: text(w.meta?.category, 30),
            minutes: m.minutes,
            tss: m.tss,
            if: m.if,
            structure: text(describeStructure(w), 90),
        });
        byRef.set(ref, w);
    }
    return {catalog, byRef};
}

// ----------------------------------------------------------------------------
// Availability (from calendar prefs)
// ----------------------------------------------------------------------------

// calendar prefs windows -> {days: [weekday...], minutesByWeekday: {0..6: minutes}}
function availabilityFromPrefs(prefs = {}) {
    const windows = normalizePrefs(prefs ?? {}).windows;
    const minutesByWeekday = {};
    const days = [];
    for(let d = 0; d < 7; d++) {
        const minutes = (windows[d] ?? []).reduce((acc, w) => acc + (w.end - w.start), 0);
        minutesByWeekday[d] = minutes;
        if(minutes > 0) days.push(d);
    }
    return {days, minutesByWeekday};
}

// -> [{date, weekday, name, available, maxMinutes}]
function planningDays({startDate, weeks = 1, availableDays = [], minutesByWeekday = {}, maxMinutesPerDay} = {}) {
    const total = clamp(Math.round(num(weeks, 1)), 1, 4) * 7;
    const out = [];
    for(let i = 0; i < total; i++) {
        const date = addDays(startDate, i);
        const weekday = weekdayOf(date);
        const available = availableDays.includes(weekday);
        let maxMinutes = num(minutesByWeekday[weekday], 0);
        if(Number.isFinite(num(maxMinutesPerDay)) && num(maxMinutesPerDay) > 0) {
            maxMinutes = maxMinutes > 0 ? Math.min(maxMinutes, num(maxMinutesPerDay)) : num(maxMinutesPerDay);
        }
        out.push({date, weekday, name: WEEKDAY_NAMES[weekday], available, maxMinutes: available ? Math.round(maxMinutes) : 0});
    }
    return out;
}

// ----------------------------------------------------------------------------
// Custom workout from typed steps (deterministic, clamped)
// ----------------------------------------------------------------------------

const STEP_KINDS = ['steady', 'ramp', 'repeats'];

const STEP_LIMITS = Object.freeze({
    minPct: 30,        // % FTP
    maxPct: 150,
    minStepSec: 10,
    maxStepMin: 120,
    maxRepeats: 30,
    maxTotalMin: 300,
    maxSteps: 40,
});

function stepSeconds(minutes, {allowZero = false} = {}) {
    const m = num(minutes);
    if(!Number.isFinite(m) || m <= 0) return allowZero ? 0 : NaN;
    return clamp(Math.round(m * 60), STEP_LIMITS.minStepSec, STEP_LIMITS.maxStepMin * 60);
}

function powerFraction(pct, fallback = NaN) {
    const p = num(pct, fallback);
    if(!Number.isFinite(p)) return NaN;
    return round(clamp(p, STEP_LIMITS.minPct, STEP_LIMITS.maxPct) / 100, 2);
}

function steady(power, duration) {
    return {duration, steps: [{duration, power}]};
}

function ramp(from, to, duration) {
    const count = clamp(Math.floor(duration / 10), 2, 60);
    const base = Math.floor(duration / count);
    const steps = [];
    let used = 0;
    for(let i = 0; i < count; i++) {
        const d = i === count - 1 ? duration - used : base;
        used += d;
        steps.push({duration: d, power: round(from + (to - from) * (i / (count - 1)), 3)});
    }
    return {duration, steps};
}

function categoryFor(metrics) {
    const x = metrics.if;
    if(x < 0.65) return 'Recovery';
    if(x < 0.78) return 'Endurance';
    if(x < 0.86) return 'Tempo';
    if(x < 0.93) return 'Sweet Spot';
    if(x < 1.0) return 'Threshold';
    return 'VO2 Max';
}

// steps: [{kind, minutes, power_pct, end_power_pct, repeats, off_minutes, off_power_pct}]
// -> workout {id, meta, intervals} | null. Invalid steps are dropped; the total
// is capped at STEP_LIMITS.maxTotalMin (later steps are cut).
function stepsToWorkout(steps, {name, description, id} = {}) {
    if(!Array.isArray(steps)) return null;
    const intervals = [];
    const maxTotal = STEP_LIMITS.maxTotalMin * 60;
    let total = 0;
    let truncated = false;

    const push = (interval) => {
        if(total + interval.duration > maxTotal) { truncated = true; return false; }
        intervals.push(interval);
        total += interval.duration;
        return true;
    };

    for(const s of steps.slice(0, STEP_LIMITS.maxSteps)) {
        if(!s || typeof s !== 'object') continue;
        const kind = STEP_KINDS.includes(s.kind) ? s.kind : 'steady';
        const secs = stepSeconds(s.minutes);
        const p = powerFraction(s.power_pct);
        if(!Number.isFinite(secs) || !Number.isFinite(p)) continue;

        if(kind === 'steady') {
            if(!push(steady(p, secs))) break;
        } else if(kind === 'ramp') {
            let p2 = powerFraction(s.end_power_pct);
            if(!Number.isFinite(p2)) p2 = p;
            if(!push(p2 === p ? steady(p, secs) : ramp(p, p2, secs))) break;
        } else {
            const reps = clamp(Math.round(num(s.repeats, 1)), 1, STEP_LIMITS.maxRepeats);
            const off = stepSeconds(s.off_minutes, {allowZero: true});
            let offP = powerFraction(s.off_power_pct);
            if(!Number.isFinite(offP)) offP = 0.5;
            let ok = true;
            for(let r = 0; r < reps && ok; r++) {
                ok = push(steady(p, secs));
                if(ok && off > 0) ok = push(steady(offP, off));
            }
            if(!ok) break;
        }
    }
    if(intervals.length === 0) return null;

    const workout = {
        id: id ?? newId('ai-plan'),
        meta: {
            name: text(name, 60) || 'AI workout',
            author: 'AI coach',
            description: text(description, 300) || 'Generated by the AI coach plan builder.',
            duration: total,
            aiGenerated: true,
        },
        intervals,
    };
    workout.meta.category = categoryFor(workoutMetrics(workout));
    if(truncated) workout.meta.truncated = true;
    return workout;
}

// ----------------------------------------------------------------------------
// Plan builder: schema, prompt, validation
// ----------------------------------------------------------------------------

const INTENSITIES = ['easy', 'moderate', 'hard'];

const STEP_SCHEMA = {
    type: 'object',
    properties: {
        kind: {type: 'string', enum: STEP_KINDS,
               description: 'steady: minutes at power_pct. ramp: minutes from power_pct to end_power_pct. repeats: repeats x (minutes at power_pct + off_minutes at off_power_pct).'},
        minutes: {type: 'number', description: 'Duration in minutes (for repeats: the ON part of one repetition).'},
        power_pct: {type: 'number', description: 'Target power in % of FTP (30-150).'},
        end_power_pct: {type: 'number', description: 'Ramp end power in % of FTP; same as power_pct otherwise.'},
        repeats: {type: 'integer', description: 'Number of repetitions for kind=repeats; 1 otherwise.'},
        off_minutes: {type: 'number', description: 'Recovery minutes between repeats; 0 otherwise.'},
        off_power_pct: {type: 'number', description: 'Recovery power in % of FTP; 0 when unused.'},
    },
    required: ['kind', 'minutes', 'power_pct', 'end_power_pct', 'repeats', 'off_minutes', 'off_power_pct'],
    additionalProperties: false,
};

const PLAN_SCHEMA = {
    type: 'object',
    properties: {
        summary: {type: 'string', description: 'Two or three sentences to the rider explaining the plan.'},
        weekly_focus: {type: 'array', items: {type: 'string'}, description: 'One short phrase per week.'},
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    date: {type: 'string', description: 'YYYY-MM-DD, one of the available dates.'},
                    workout_ref: {type: 'string', description: 'Catalog ref (e.g. "w12"), or "" when using custom steps.'},
                    custom_name: {type: 'string', description: 'Name for a custom workout; "" when workout_ref is used.'},
                    steps: {type: 'array', items: STEP_SCHEMA, description: 'Custom workout steps incl. warm-up and cool-down; [] when workout_ref is used.'},
                    intensity: {type: 'string', enum: INTENSITIES},
                    rationale: {type: 'string', description: 'One short sentence: why this session on this day.'},
                },
                required: ['date', 'workout_ref', 'custom_name', 'steps', 'intensity', 'rationale'],
                additionalProperties: false,
            },
        },
    },
    required: ['summary', 'weekly_focus', 'entries'],
    additionalProperties: false,
};

const PLAN_SYSTEM_PROMPT = `You are an experienced, evidence-based cycling coach building the next week(s) of indoor trainer sessions for one rider.

Rules:
- Only schedule on dates listed as available, at most one session per date, and keep each session within that date's maxMinutes. Keep the weekly total within the rider's weekly hours.
- Prefer workouts from the catalog: set workout_ref to the catalog ref, custom_name to "" and steps to []. Only when nothing in the catalog fits, set workout_ref to "" and describe a simple custom workout in steps (include a warm-up and cool-down, power in % of FTP).
- Existing plan entries are kept and listed for context; do not schedule on dates that already have one unless told they will be replaced.
- Balance stress: no back-to-back hard days, most sessions easy/moderate, progressive load across weeks, and a lighter week after 3 build weeks. Taper before an event date.
- Use the recent training load and wellness: back off when fatigue is high or recovery is poor; missing data is not evidence of poor recovery.
- It is fine to leave available days empty; rest is training too.
This is training guidance, not medical advice.`;

function compactLoad(load) {
    if(!load) return null;
    const {activities, ...rest} = load;
    return Object.assign(rest, {
        recent: (activities ?? []).slice(-14).map((a) => ({
            date: a.date, name: text(a.name, 40), minutes: a.minutes, load: a.load,
        })),
    });
}

function buildPlanPrompt({
    today, startDate, weeks, goal, goalDetails, eventDate, ftp, weeklyHours,
    days = [], existing = [], replaceExisting = false, load, wellness, catalog = [],
} = {}) {
    return [
        `Today: ${today}. Plan ${weeks} week(s) starting ${startDate}.`,
        `Goal: ${text(goal, 80) || 'general fitness'}${goalDetails ? ` — ${text(goalDetails, 300)}` : ''}`,
        eventDate ? `Event date: ${eventDate}` : 'No event date.',
        `FTP: ${ftp ?? 'unknown'} W. Weekly hours available: ${weeklyHours ?? 'not set'}.`,
        '',
        'Available dates (maxMinutes per day; 0 = not available):',
        JSON.stringify(days.map((d) => ({date: d.date, day: d.name, maxMinutes: d.maxMinutes}))),
        '',
        `Existing plan entries in this period (${replaceExisting ? 'planned ones WILL BE REPLACED by your plan' : 'kept, do not double-book'}):`,
        JSON.stringify(existing.map((e) => ({
            date: e.date, workout: text(e.workoutName, 60), minutes: e.durationMin ?? null, status: e.status,
        }))),
        '',
        `Recent training load (source: ${load?.source ?? 'none'}):`,
        JSON.stringify(compactLoad(load) ?? {}),
        '',
        `Wellness today (source: ${wellness?.source ?? 'none'}):`,
        JSON.stringify(wellness ?? {}),
        '',
        'Workout catalog (ref, name, category, minutes, estimated TSS and IF, structure in % FTP):',
        JSON.stringify(catalog.map((c) => [c.ref, c.name, c.category, c.minutes, c.tss, c.if, c.structure])),
        '',
        'Build the plan.',
    ].join('\n');
}

// raw Claude output -> {summary, weeklyFocus, entries, warnings}
// ctx: {byRef, days, existing, replaceExisting, today, weeklyHours, maxPerDay}
function validatePlan(raw, ctx = {}) {
    const {
        byRef = new Map(), days = [], existing = [], replaceExisting = false,
        today, weeklyHours, maxPerDay = 1,
    } = ctx;
    const dayMap = new Map(days.map((d) => [d.date, d]));
    const warnings = [];
    const entries = [];
    const perDate = new Map();
    const blocked = new Set(replaceExisting ? [] :
        existing.filter((e) => (e.status ?? 'planned') !== 'skipped').map((e) => e.date));

    const list = Array.isArray(raw?.entries) ? raw.entries.slice(0, 60) : [];
    list.forEach((e, i) => {
        const date = typeof e?.date === 'string' ? e.date.trim() : '';
        if(!isISODate(date) || !dayMap.has(date)) {
            warnings.push(`Dropped a session on "${text(date, 12)}": outside the planning period.`);
            return;
        }
        if(today && date < today) {
            warnings.push(`Dropped a session on ${date}: in the past.`);
            return;
        }
        if(blocked.has(date)) {
            warnings.push(`Dropped a session on ${date}: you already have a ride planned.`);
            return;
        }
        if((perDate.get(date) ?? 0) >= maxPerDay) {
            warnings.push(`Dropped an extra session on ${date}.`);
            return;
        }

        const entryWarnings = [];
        const ref = text(e.workout_ref, 12);
        let workout;
        let source;
        let workoutId;
        if(ref && byRef.has(ref)) {
            const lib = byRef.get(ref);
            workout = clone(lib);
            workoutId = lib.id ?? null;
            source = 'library';
        } else {
            if(ref) entryWarnings.push(`Unknown catalog ref ${ref}; used the custom steps.`);
            workout = stepsToWorkout(e.steps, {name: e.custom_name, description: e.rationale});
            if(!workout) {
                warnings.push(`Dropped a session on ${date}: no valid workout.`);
                return;
            }
            if(workout.meta.truncated) entryWarnings.push(`Custom workout cut to ${STEP_LIMITS.maxTotalMin} min.`);
            workoutId = workout.id;
            source = 'custom';
        }

        const m = workoutMetrics(workout);
        const day = dayMap.get(date);
        if(!day.available) entryWarnings.push(`${day.name} is not one of your available days.`);
        if(day.maxMinutes > 0 && m.minutes > day.maxMinutes * 1.1) {
            entryWarnings.push(`${m.minutes} min is longer than your ${day.maxMinutes} min on ${day.name}.`);
        }
        perDate.set(date, (perDate.get(date) ?? 0) + 1);
        entries.push({
            key: `p${i}`,
            date,
            workout,
            workoutId,
            workoutName: text(workout.meta?.name, 80) || 'Workout',
            source,
            ref: source === 'library' ? ref : '',
            durationMin: m.minutes,
            tss: m.tss,
            if: m.if,
            hard: isHardWorkout(m) || e.intensity === 'hard',
            notes: text(e.rationale, 300),
            warnings: entryWarnings,
            include: true,
        });
    });

    entries.sort((a, b) => a.date.localeCompare(b.date));

    for(let i = 1; i < entries.length; i++) {
        const a = entries[i - 1];
        const b = entries[i];
        if(a.hard && b.hard && diffDays(a.date, b.date) === 1) {
            b.warnings.push('Hard session the day after another hard session.');
        }
    }

    const cap = num(weeklyHours);
    if(Number.isFinite(cap) && cap > 0) {
        for(const [week, minutes] of weekTotals(entries).map((w) => [w.week, w.minutes])) {
            if(minutes > cap * 60 * 1.1) {
                warnings.push(`Week of ${week}: ${Math.round(minutes / 6) / 10} h planned, above your ${cap} h.`);
            }
        }
    }

    return {
        summary: text(raw?.summary, 800),
        weeklyFocus: (Array.isArray(raw?.weekly_focus) ? raw.weekly_focus : []).slice(0, 8).map((x) => text(x, 120)),
        entries,
        warnings,
    };
}

function weekTotals(entries = []) {
    const map = new Map();
    for(const e of entries) {
        if(e.include === false) continue;
        const week = weekStart(e.date);
        const t = map.get(week) ?? {week, minutes: 0, tss: 0, count: 0};
        t.minutes += e.durationMin ?? 0;
        t.tss += e.tss ?? 0;
        t.count += 1;
        map.set(week, t);
    }
    return Array.from(map.values()).sort((a, b) => a.week.localeCompare(b.week));
}

// preview entry -> TrainingPlan entry (snapshot so library id churn is harmless)
function previewToPlanEntry(p) {
    return {
        date: p.date,
        workoutId: p.workoutId ?? null,
        workoutName: p.workoutName,
        durationMin: p.durationMin,
        notes: p.notes ? `AI plan: ${p.notes}` : 'AI plan',
        status: 'planned',
        hard: !!p.hard,
        workout: workoutSnapshot(p.workout),
        source: p.source === 'custom' ? 'ai-custom' : 'ai',
    };
}

// pure: merge accepted preview entries into an existing entry list
function mergePlanEntries(existing = [], accepted = [], {replaceExisting = false, from, to} = {}) {
    const kept = (existing ?? []).filter((e) => !(replaceExisting &&
        (e.status ?? 'planned') === 'planned' && e.date >= from && e.date <= to));
    return kept.concat(accepted.map(previewToPlanEntry));
}

// ----------------------------------------------------------------------------
// Coach feedback -> structured plan changes
// ----------------------------------------------------------------------------

const CHANGE_ACTIONS = [
    'scale',           // intensity_percent of the planned power
    'shorten',         // duration_minutes
    'swap_library',    // workout_ref from the catalog
    'swap_endurance',  // steady Z2 ride of duration_minutes
    'swap_recovery',   // easy Z1 spin of duration_minutes
    'move',            // to new_date
    'rest',            // skip the session
];

const CHANGES_SCHEMA = {
    type: 'object',
    properties: {
        summary: {type: 'string', description: 'One or two sentences on why the plan should change (or not).'},
        changes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    entry_ref: {type: 'string', description: 'Ref of the upcoming entry (e.g. "e2").'},
                    action: {type: 'string', enum: CHANGE_ACTIONS},
                    intensity_percent: {type: 'integer', description: `scale: % of planned power (${LIMITS.intensityMin}-${LIMITS.intensityMax}); 100 otherwise.`},
                    duration_minutes: {type: 'integer', description: 'shorten / swap_endurance / swap_recovery: total minutes; 0 otherwise.'},
                    new_date: {type: 'string', description: 'move: YYYY-MM-DD; "" otherwise.'},
                    workout_ref: {type: 'string', description: 'swap_library: catalog ref; "" otherwise.'},
                    reason: {type: 'string', description: 'One short sentence.'},
                },
                required: ['entry_ref', 'action', 'intensity_percent', 'duration_minutes', 'new_date', 'workout_ref', 'reason'],
                additionalProperties: false,
            },
        },
    },
    required: ['summary', 'changes'],
    additionalProperties: false,
};

const CHANGES_SYSTEM_PROMPT = `You are an experienced, evidence-based cycling coach. After reviewing a ride you gave feedback with suggested adjustments. Now turn those suggestions into concrete changes to the rider's upcoming planned sessions.

Allowed actions per entry: scale (intensity_percent of the planned power), shorten (duration_minutes), swap_library (a catalog workout_ref), swap_endurance / swap_recovery (easy ride of duration_minutes), move (to new_date, within a week), rest (skip it).
Only change entries listed as upcoming, at most one change per entry, and only when it follows from the feedback. Be conservative: the smallest change that addresses the issue. An empty list is fine. Training guidance only, not medical advice.`;

// plans: TrainingPlan[] -> [{ref, planId, planName, entry}]
function upcomingEntries(plans = [], {today, horizonDays = 14} = {}) {
    const end = addDays(today, horizonDays);
    const list = [];
    for(const plan of plans ?? []) {
        for(const entry of plan.entries ?? []) {
            if((entry.status ?? 'planned') !== 'planned') continue;
            if(entry.date < today || entry.date > end) continue;
            list.push({planId: plan.id, planName: plan.name, entry});
        }
    }
    list.sort((a, b) => a.entry.date.localeCompare(b.entry.date));
    return list.map((x, i) => Object.assign(x, {ref: `e${i + 1}`}));
}

function entrySummary(entry, workouts) {
    const w = resolveWorkout(entry, workouts);
    const m = w ? workoutMetrics(w) : null;
    return {
        date: entry.date,
        workout: text(entry.workoutName || w?.meta?.name, 80),
        minutes: m ? m.minutes : (entry.durationMin ?? null),
        tss: m ? m.tss : null,
        if: m ? m.if : null,
        structure: w ? text(describeStructure(w), 120) : null,
    };
}

function buildChangesPrompt({today, ftp, feedback, upcoming = [], workouts = [], catalog = []} = {}) {
    const fb = feedback ?? {};
    return [
        `Today: ${today}. FTP: ${ftp ?? 'unknown'} W.`,
        '',
        'Your feedback on the ride:',
        JSON.stringify({
            rating: fb.rating ?? null,
            headline: text(fb.headline, 300),
            improve: (fb.improve ?? []).map((x) => text(x, 200)),
            adjustments: (fb.adjustments ?? []).map((a) => ({when: text(a.when, 60), suggestion: text(a.suggestion, 300)})),
        }),
        '',
        'Upcoming planned sessions (ref -> summary):',
        JSON.stringify(Object.fromEntries(upcoming.map((u) => [u.ref, entrySummary(u.entry, workouts)]))),
        '',
        'Workout catalog for swap_library (ref, name, category, minutes, TSS, IF):',
        JSON.stringify(catalog.map((c) => [c.ref, c.name, c.category, c.minutes, c.tss, c.if])),
        '',
        'Propose the changes.',
    ].join('\n');
}

function metricsView(entry, workout, date) {
    const m = workout ? workoutMetrics(workout) : null;
    return {
        date: date ?? entry.date,
        name: text(workout?.meta?.name ?? entry.workoutName, 80),
        minutes: m ? m.minutes : (entry.durationMin ?? null),
        tss: m ? m.tss : null,
    };
}

const ACTION_LABELS = {
    scale: 'Scale intensity',
    shorten: 'Shorten',
    swap_library: 'Swap workout',
    swap_endurance: 'Swap to endurance',
    swap_recovery: 'Swap to recovery',
    move: 'Move',
    rest: 'Rest day',
};

// raw Claude output -> {summary, changes, warnings}
// ctx: {upcoming, byRef, workouts, today, maxMoveDays}
function validateChanges(raw, ctx = {}) {
    const {upcoming = [], byRef = new Map(), workouts = [], today, maxMoveDays = 7} = ctx;
    const refs = new Map(upcoming.map((u) => [u.ref, u]));
    const done = new Set();
    const warnings = [];
    const changes = [];

    const list = Array.isArray(raw?.changes) ? raw.changes.slice(0, 30) : [];
    list.forEach((c, i) => {
        const ref = text(c?.entry_ref, 12);
        const u = refs.get(ref);
        if(!u) { warnings.push(`Ignored a change for unknown session "${ref}".`); return; }
        if(done.has(ref)) { warnings.push(`Ignored a second change for ${u.entry.date}.`); return; }
        const action = CHANGE_ACTIONS.includes(c.action) ? c.action : null;
        if(!action) { warnings.push(`Ignored an unknown action for ${u.entry.date}.`); return; }

        const entry = u.entry;
        const original = resolveWorkout(entry, workouts);
        const reason = text(c.reason, 300);
        const change = {
            id: `c${i}`, action, label: ACTION_LABELS[action], ref,
            planId: u.planId, planName: u.planName, entryId: entry.id,
            reason, warnings: [], selected: true,
            before: metricsView(entry, original),
        };

        if(action === 'rest') {
            change.after = {date: entry.date, name: 'Rest', minutes: 0, tss: 0};
        } else if(action === 'move') {
            const date = typeof c.new_date === 'string' ? c.new_date.trim() : '';
            if(!isISODate(date) || date === entry.date || (today && date < today) ||
               Math.abs(diffDays(entry.date, date)) > maxMoveDays) {
                warnings.push(`Ignored moving ${entry.date} to "${text(date, 12)}".`);
                return;
            }
            change.newDate = date;
            change.after = Object.assign({}, change.before, {date});
            const clash = upcoming.find((x) => x.entry.id !== entry.id && x.entry.date === date);
            if(clash) change.warnings.push(`${date} already has ${text(clash.entry.workoutName, 40)}.`);
        } else if(action === 'swap_library') {
            const lib = byRef.get(text(c.workout_ref, 12));
            if(!lib) { warnings.push(`Ignored a swap on ${entry.date}: unknown workout.`); return; }
            change.workout = clone(lib);
            change.after = metricsView(entry, change.workout);
        } else {
            if(!original) {
                warnings.push(`Ignored "${ACTION_LABELS[action]}" on ${entry.date}: workout not found.`);
                return;
            }
            const decisionName = {
                scale: 'scale_intensity', shorten: 'shorten',
                swap_endurance: 'swap_endurance', swap_recovery: 'swap_recovery',
            }[action];
            const decision = sanitizeDecision({
                decision: decisionName,
                intensity_percent: c.intensity_percent,
                duration_minutes: c.duration_minutes,
                rationale: reason,
            }, original);
            const planned = Math.round(workoutDuration(original) / 60);
            if(action === 'scale' && decision.intensityPercent === 100) {
                warnings.push(`Ignored scaling ${entry.date} to 100%.`); return;
            }
            if(action === 'shorten' && decision.durationMinutes >= planned) {
                warnings.push(`Ignored shortening ${entry.date}: not shorter.`); return;
            }
            change.decision = decision;
            change.workout = applyDecision(original, decision);
            change.after = metricsView(entry, change.workout);
        }

        done.add(ref);
        changes.push(change);
    });

    return {summary: text(raw?.summary, 600), changes, warnings};
}

// entry patch for a replaced workout; keeps the very first original in adjustedFrom
function adjustedEntryPatch(entry, workout, {by = 'ai', note = '', at = new Date().toISOString(), decision} = {}) {
    const m = workoutMetrics(workout);
    const patch = {
        workoutId: workout.id ?? null,
        workoutName: text(workout.meta?.name, 80) || entry.workoutName,
        workout: workoutSnapshot(workout),
        durationMin: m.minutes,
        hard: isHardWorkout(m),
        adjustedFrom: entry.adjustedFrom ?? {
            workoutId: entry.workoutId ?? null,
            workoutName: entry.workoutName ?? '',
            workout: entry.workout ? clone(entry.workout) : undefined,
            by,
            at,
        },
    };
    if(patch.adjustedFrom.workout === undefined) delete patch.adjustedFrom.workout;
    if(decision) patch.adjustedFrom = Object.assign({}, patch.adjustedFrom, {lastDecision: decision, lastAt: at, lastBy: by});
    if(note) patch.notes = [entry.notes, note].filter(Boolean).join('\n');
    return patch;
}

function changePatch(entry, change, {at = new Date().toISOString()} = {}) {
    const note = `Coach: ${change.label}${change.reason ? ` — ${change.reason}` : ''}`;
    if(change.action === 'rest') {
        return {status: 'skipped', notes: [entry.notes, note].filter(Boolean).join('\n')};
    }
    if(change.action === 'move') {
        // let the calendar pick a fresh slot on the new day
        return {date: change.newDate, targetTime: undefined, notes: [entry.notes, note].filter(Boolean).join('\n')};
    }
    return adjustedEntryPatch(entry, change.workout, {by: 'coach', note, at, decision: change.action});
}

// pure: apply the selected changes to one plan's entries -> new entries array
function applyChangesToEntries(entries = [], changes = [], opts = {}) {
    const byEntry = new Map(changes.map((c) => [c.entryId, c]));
    return entries.map((entry) => {
        const change = byEntry.get(entry.id);
        if(!change) return entry;
        const next = Object.assign({}, entry, changePatch(entry, change, opts));
        if(next.targetTime === undefined) delete next.targetTime;
        return next;
    });
}

export {
    WEEKDAY_NAMES,
    STEP_KINDS,
    STEP_LIMITS,
    PLAN_SCHEMA,
    PLAN_SYSTEM_PROMPT,
    CHANGE_ACTIONS,
    CHANGES_SCHEMA,
    CHANGES_SYSTEM_PROMPT,
    ACTION_LABELS,
    isISODate,
    buildCatalog,
    availabilityFromPrefs,
    planningDays,
    stepsToWorkout,
    buildPlanPrompt,
    validatePlan,
    weekTotals,
    previewToPlanEntry,
    mergePlanEntries,
    upcomingEntries,
    buildChangesPrompt,
    validateChanges,
    adjustedEntryPatch,
    changePatch,
    applyChangesToEntries,
};
