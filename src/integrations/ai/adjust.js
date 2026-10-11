// Deterministic workout transforms + readiness decision schema/prompt.
//
// Claude only *chooses* an adjustment (keep / scale / shorten / swap / rest)
// with a couple of numbers; the adjusted workout is always produced here, in
// plain JS, from the original workout. No AI-generated steps.
//
// Workout format (see src/workouts/zwo.js readToInterval):
//   { meta: {name, duration, ...}, intervals: [{duration, steps: [{duration,
//     power (fraction of FTP), cadence?, slope?}]}] }

const DECISIONS = [
    'keep',
    'scale_intensity',
    'shorten',
    'scale_and_shorten',
    'swap_endurance',
    'swap_recovery',
    'rest',
];

const LIMITS = Object.freeze({
    intensityMin: 50,   // % of planned power
    intensityMax: 105,
    minMinutes:   15,
});

// Coggan-style zones as fraction of FTP (matches models.ftp defaults)
const ZONES = [
    {name: 'Z1', max: 0.55, color: '#636468'},
    {name: 'Z2', max: 0.76, color: '#328AFF'},
    {name: 'Z3', max: 0.88, color: '#44A5AB'},
    {name: 'Z4', max: 0.95, color: '#57C057'},
    {name: 'Z5', max: 1.06, color: '#F8C73A'},
    {name: 'Z6', max: 1.20, color: '#FF663A'},
    {name: 'Z7', max: Infinity, color: '#FE340B'},
];

function zoneOf(power = 0) {
    return ZONES.find((z) => power < z.max) ?? ZONES[ZONES.length - 1];
}

function clone(x) {
    return JSON.parse(JSON.stringify(x));
}

function round(x, digits = 0) {
    const f = 10 ** digits;
    return Math.round(x * f) / f;
}

function clamp(x, min, max) {
    return Math.min(max, Math.max(min, x));
}

function newId() {
    try {
        if(globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch(e) {}
    return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// ----------------------------------------------------------------------------
// Metrics
// ----------------------------------------------------------------------------

function intervalDuration(interval) {
    if(Array.isArray(interval.steps) && interval.steps.length > 0) {
        return interval.steps.reduce((acc, s) => acc + (s.duration ?? 0), 0);
    }
    return interval.duration ?? 0;
}

function workoutDuration(workout) {
    return (workout?.intervals ?? []).reduce((acc, i) => acc + intervalDuration(i), 0);
}

function steps(workout) {
    return (workout?.intervals ?? []).flatMap((i) => i.steps ?? []);
}

function intervalAvgPower(interval) {
    const d = intervalDuration(interval);
    if(d === 0) return 0;
    return (interval.steps ?? []).reduce((acc, s) => acc + (s.power ?? 0) * (s.duration ?? 0), 0) / d;
}

// Estimated NP (as fraction of FTP), IF and TSS from the targets.
// Uses a 30s-step 4th power mean — close enough for planning comparisons.
function workoutMetrics(workout) {
    const ss = steps(workout);
    const duration = ss.reduce((acc, s) => acc + (s.duration ?? 0), 0);
    if(duration === 0) return {duration: 0, minutes: 0, if: 0, tss: 0, maxPower: 0, zones: {}};

    let p4 = 0;
    let max = 0;
    const zones = {};
    for(const s of ss) {
        const p = s.power ?? 0;
        const d = s.duration ?? 0;
        p4 += (p ** 4) * d;
        if(p > max) max = p;
        const z = zoneOf(p).name;
        zones[z] = (zones[z] ?? 0) + d;
    }
    const np = (p4 / duration) ** 0.25;
    const tss = (duration / 3600) * np * np * 100;

    return {
        duration,
        minutes: round(duration / 60),
        if: round(np, 2),
        tss: round(tss),
        maxPower: round(max, 2),
        zones: Object.fromEntries(Object.entries(zones).map(([k, v]) => [k, round(v / 60)])),
    };
}

function fmtTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.round(secs % 60);
    return s === 0 ? `${m}min` : `${m}:${String(s).padStart(2, '0')}`;
}

function intervalLabel(interval) {
    const ss = interval.steps ?? [];
    const first = ss[0]?.power ?? 0;
    const last = ss[ss.length - 1]?.power ?? 0;
    const pct = (p) => `${Math.round(p * 100)}%`;
    const power = Math.abs(first - last) > 0.01 ? `${pct(first)}→${pct(last)}` : pct(first);
    return `${fmtTime(intervalDuration(interval))}@${power}`;
}

// compact human/AI readable structure, collapsing repeats: "3x(5min@105%, 3min@50%)"
function describeStructure(workout) {
    const labels = (workout?.intervals ?? []).map(intervalLabel);
    const out = [];
    let i = 0;
    while(i < labels.length) {
        let best = {len: 1, reps: 1};
        for(let len = 1; len <= 4; len++) {
            let reps = 1;
            while(
                i + (reps + 1) * len <= labels.length &&
                labels.slice(i, i + len).join() === labels.slice(i + reps * len, i + (reps + 1) * len).join()
            ) reps++;
            if(reps > 1 && reps * len > best.reps * best.len) best = {len, reps};
        }
        const chunk = labels.slice(i, i + best.len).join(', ');
        out.push(best.reps > 1 ? `${best.reps}x(${chunk})` : chunk);
        i += best.len * best.reps;
    }
    return out.join(', ');
}

function summarizeWorkout(workout, ftp) {
    const m = workoutMetrics(workout);
    return {
        name: workout?.meta?.name ?? 'Workout',
        category: workout?.meta?.category,
        minutes: m.minutes,
        estimatedIF: m.if,
        estimatedTSS: m.tss,
        maxPowerPctFtp: Math.round(m.maxPower * 100),
        minutesInZone: m.zones,
        ftp,
        structure: describeStructure(workout),
    };
}

// ----------------------------------------------------------------------------
// Transforms (all pure: return new workouts, never mutate the input)
// ----------------------------------------------------------------------------

function finalize(workout, original, suffix, adjustment) {
    const w = workout;
    w.intervals = w.intervals.map((i) => Object.assign(i, {duration: intervalDuration(i)}));
    w.meta = Object.assign({}, original.meta ?? {}, {
        name: `${original.meta?.name ?? 'Workout'} (${suffix})`,
        duration: workoutDuration(w),
        adjustedFrom: original.id,
        adjustment,
    });
    delete w.meta.planned;
    w.id = newId();
    return w;
}

// Scale every power target by pct (e.g. 90 = -10%). Slope/cadence untouched.
function scaleIntensity(workout, pct) {
    const factor = clamp(pct, LIMITS.intensityMin, LIMITS.intensityMax) / 100;
    const w = clone(workout);
    for(const interval of w.intervals) {
        for(const step of interval.steps ?? []) {
            if(typeof step.power === 'number' && step.power > 0) {
                step.power = round(step.power * factor, 3);
            }
        }
    }
    return w;
}

const WARMUP_MAX_POWER = 0.76; // leading intervals below this count as warm-up
const COOLDOWN_MAX_POWER = 0.65;

function splitPhases(intervals) {
    let start = 0;
    let warmupSecs = 0;
    while(
        start < intervals.length - 1 &&
        intervalAvgPower(intervals[start]) < WARMUP_MAX_POWER &&
        warmupSecs < 20 * 60
    ) {
        warmupSecs += intervalDuration(intervals[start]);
        start++;
    }
    let end = intervals.length;
    let cooldownSecs = 0;
    while(
        end - 1 > start &&
        intervalAvgPower(intervals[end - 1]) < COOLDOWN_MAX_POWER &&
        cooldownSecs < 15 * 60
    ) {
        end--;
        cooldownSecs += intervalDuration(intervals[end]);
    }
    return {
        warmup:   intervals.slice(0, start),
        main:     intervals.slice(start, end),
        cooldown: intervals.slice(end),
    };
}

function scaleIntervalDuration(interval, factor) {
    const i = clone(interval);
    for(const s of i.steps ?? []) s.duration = Math.max(1, Math.round((s.duration ?? 0) * factor));
    i.duration = intervalDuration(i);
    return i;
}

// Shorten to at most `minutes`: keep warm-up and cool-down, drop main-set
// intervals from the end (so earlier reps are done fully), and if warm-up +
// cool-down alone are too long, compress them proportionally.
function shortenWorkout(workout, minutes) {
    const total = workoutDuration(workout);
    const target = Math.max(LIMITS.minMinutes, minutes) * 60;
    const w = clone(workout);
    if(target >= total) return w;

    const { warmup, main, cooldown } = splitPhases(w.intervals);
    const fixed = [...warmup, ...cooldown].reduce((acc, i) => acc + intervalDuration(i), 0);

    if(fixed >= target || main.length === 0) {
        const factor = target / total;
        w.intervals = w.intervals.map((i) => scaleIntervalDuration(i, factor));
        return w;
    }

    const budget = target - fixed;
    const kept = [];
    let used = 0;
    for(const interval of main) {
        const d = intervalDuration(interval);
        if(used + d > budget) {
            // fill the remainder with a partial interval if it is worth it (>= 60s)
            const rest = budget - used;
            if(rest >= 60) kept.push(scaleIntervalDuration(interval, rest / d));
            break;
        }
        kept.push(interval);
        used += d;
    }
    w.intervals = [...warmup, ...kept, ...cooldown];
    return w;
}

function rampInterval(from, to, secs, dx = 10) {
    const count = Math.max(2, Math.floor(secs / dx));
    const stepDur = secs / count;
    const ss = [];
    for(let i = 0; i < count; i++) {
        const p = from + (to - from) * (i / (count - 1));
        ss.push({duration: round(stepDur, 2), power: round(p, 3)});
    }
    return {duration: secs, steps: ss};
}

function steadyInterval(power, secs) {
    return {duration: secs, steps: [{duration: secs, power}]};
}

// Replace the session with an easy steady ride of `minutes` at `power`.
function easyWorkout(minutes, power) {
    const total = Math.max(LIMITS.minMinutes, minutes) * 60;
    const warm = Math.min(10 * 60, Math.round(total * 0.2));
    const cool = Math.min(5 * 60, Math.round(total * 0.1));
    const steady = total - warm - cool;
    return {
        meta: {},
        intervals: [
            rampInterval(0.45, power, warm),
            steadyInterval(power, steady),
            rampInterval(power, 0.4, cool),
        ],
    };
}

const SWAPS = {
    swap_endurance: {power: 0.65, label: 'Endurance'},
    swap_recovery:  {power: 0.50, label: 'Recovery'},
};

// Normalize & clamp whatever Claude returned into a safe decision object.
function sanitizeDecision(raw = {}, workout) {
    const plannedMinutes = Math.round(workoutDuration(workout) / 60);
    const decision = DECISIONS.includes(raw.decision) ? raw.decision : 'keep';

    let intensity = Number(raw.intensity_percent);
    if(!Number.isFinite(intensity)) intensity = 100;
    intensity = Math.round(clamp(intensity, LIMITS.intensityMin, LIMITS.intensityMax));

    let duration = Number(raw.duration_minutes);
    if(!Number.isFinite(duration) || duration <= 0) duration = plannedMinutes;
    duration = Math.round(clamp(duration, Math.min(LIMITS.minMinutes, plannedMinutes), Math.max(plannedMinutes, LIMITS.minMinutes)));

    const result = {
        decision,
        intensityPercent: 100,
        durationMinutes: plannedMinutes,
        rationale: String(raw.rationale ?? '').slice(0, 1000),
        readiness: ['high', 'normal', 'low', 'very_low'].includes(raw.readiness) ? raw.readiness : 'normal',
        keyFactors: Array.isArray(raw.key_factors) ? raw.key_factors.slice(0, 6).map(String) : [],
    };

    if(decision === 'scale_intensity' || decision === 'scale_and_shorten') result.intensityPercent = intensity;
    if(decision === 'shorten' || decision === 'scale_and_shorten') result.durationMinutes = Math.min(duration, plannedMinutes);
    if(decision in SWAPS) result.durationMinutes = duration;
    if(decision === 'rest') result.durationMinutes = 0;

    return result;
}

// (original workout, sanitized decision) -> adjusted copy | null (rest)
function applyDecision(workout, decision) {
    const d = decision.decision;
    const plannedMinutes = Math.round(workoutDuration(workout) / 60);

    if(d === 'rest') return null;

    if(d in SWAPS) {
        const swap = SWAPS[d];
        const w = easyWorkout(decision.durationMinutes || plannedMinutes, swap.power);
        w.meta = {category: swap.label};
        return finalize(w, workout, `AI: ${swap.label.toLowerCase()} swap`, decision);
    }

    let w = clone(workout);
    const parts = [];
    if((d === 'scale_intensity' || d === 'scale_and_shorten') && decision.intensityPercent !== 100) {
        w = scaleIntensity(w, decision.intensityPercent);
        parts.push(`${decision.intensityPercent}%`);
    }
    if((d === 'shorten' || d === 'scale_and_shorten') && decision.durationMinutes < plannedMinutes) {
        w = shortenWorkout(w, decision.durationMinutes);
        parts.push(`${Math.round(workoutDuration(w) / 60)}min`);
    }
    if(parts.length === 0) return finalize(w, workout, 'AI: as planned', decision);
    return finalize(w, workout, `AI: ${parts.join(', ')}`, decision);
}

// ----------------------------------------------------------------------------
// Claude request
// ----------------------------------------------------------------------------

const DECISION_SCHEMA = {
    type: 'object',
    properties: {
        decision: {
            type: 'string',
            enum: DECISIONS,
            description: 'What to do with today\'s planned workout.',
        },
        intensity_percent: {
            type: 'integer',
            description: `Percent of planned power targets to use (${LIMITS.intensityMin}-${LIMITS.intensityMax}). 100 unless the decision scales intensity.`,
        },
        duration_minutes: {
            type: 'integer',
            description: 'Target total duration in minutes. The planned duration unless the decision shortens or swaps; 0 for rest.',
        },
        readiness: {
            type: 'string',
            enum: ['high', 'normal', 'low', 'very_low'],
        },
        key_factors: {
            type: 'array',
            items: {type: 'string'},
            description: 'Up to 4 short bullet phrases naming the data that drove the decision.',
        },
        rationale: {
            type: 'string',
            description: 'Two or three plain sentences to the rider explaining the decision.',
        },
    },
    required: ['decision', 'intensity_percent', 'duration_minutes', 'readiness', 'key_factors', 'rationale'],
    additionalProperties: false,
};

const SYSTEM_PROMPT = `You are an experienced cycling coach reviewing a rider's readiness before today's indoor trainer session.

You receive: today's planned workout (summary and structure, power as % of FTP), wellness data (from intervals.icu and/or the rider's own check-in), and recent training load. Decide one adjustment:
- keep: ride as planned.
- scale_intensity: same structure, power targets scaled to intensity_percent (typically 85-97).
- shorten: same intensity, cut to duration_minutes (warm-up and cool-down are kept, the main set is trimmed from the end).
- scale_and_shorten: both.
- swap_endurance: replace with a steady Z2 ride of duration_minutes.
- swap_recovery: replace with an easy Z1 spin of duration_minutes.
- rest: skip today.

Guidance: a single mildly poor metric rarely justifies a change; look for agreement between signals (HRV well below baseline, resting HR elevated 5+ bpm, short or poor sleep, high soreness/fatigue/stress, low "feel", very negative TSB or a heavy recent block). Missing data is not evidence of poor recovery. Prefer the smallest adjustment that protects the rider; keep hard sessions when the rider is fresh. Suggest rest only for clearly poor recovery or signs of illness/injury in notes. Subjective scales are 1-5: sleepQuality/feel/mood/motivation higher is better; soreness/fatigue/stress higher is worse.

This is training guidance, not medical advice; if notes mention illness, chest pain, or injury, recommend rest and suggest seeing a professional in the rationale.`;

function buildPrompt({date, workout, workoutSummary, wellness, load}) {
    const summary = workoutSummary ?? summarizeWorkout(workout);
    return [
        `Date: ${date}`,
        '',
        'Planned workout:',
        JSON.stringify(summary, null, 1),
        '',
        'Wellness today (source: ' + (wellness?.source ?? 'none') + '):',
        JSON.stringify(wellness ?? {}, null, 1),
        '',
        `Recent training (last ${load?.days ?? 14} days, source: ${load?.source ?? 'none'}):`,
        JSON.stringify(load ?? {}, null, 1),
        '',
        'Choose the adjustment for today\'s session.',
    ].join('\n');
}

export {
    DECISIONS,
    LIMITS,
    ZONES,
    DECISION_SCHEMA,
    SYSTEM_PROMPT,
    zoneOf,
    intervalDuration,
    workoutDuration,
    workoutMetrics,
    describeStructure,
    summarizeWorkout,
    scaleIntensity,
    shortenWorkout,
    easyWorkout,
    splitPhases,
    sanitizeDecision,
    applyDecision,
    buildPrompt,
};
