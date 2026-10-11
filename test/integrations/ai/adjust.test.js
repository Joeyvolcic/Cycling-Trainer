import {
    workoutDuration, workoutMetrics, describeStructure, summarizeWorkout,
    scaleIntensity, shortenWorkout, easyWorkout, splitPhases,
    sanitizeDecision, applyDecision, buildPrompt, DECISION_SCHEMA, LIMITS,
} from '../../../src/integrations/ai/adjust.js';

function steady(power, duration) {
    return {duration, steps: [{duration, power}]};
}
function ramp(from, to, duration, n = 10) {
    const d = duration / n;
    return {duration, steps: Array.from({length: n}, (_, i) => ({duration: d, power: from + (to - from) * i / (n - 1)}))};
}

// 10min warmup, 5x(5min@100%, 5min@50%), 10min cooldown = 70min
function threshold() {
    const main = [];
    for(let i = 0; i < 5; i++) {
        main.push(steady(1.0, 300));
        main.push(steady(0.5, 300));
    }
    return {
        id: 'orig-1',
        meta: {name: 'Threshold', duration: 4200, planned: true},
        intervals: [ramp(0.4, 0.7, 600), ...main, ramp(0.6, 0.4, 600)],
    };
}

describe('metrics', () => {
    test('workoutDuration sums step durations', () => {
        expect(workoutDuration(threshold())).toBe(4200);
    });

    test('workoutMetrics estimates IF/TSS and zone minutes', () => {
        const m = workoutMetrics(threshold());
        expect(m.minutes).toBe(70);
        expect(m.if).toBeGreaterThan(0.75);
        expect(m.if).toBeLessThan(0.95);
        expect(m.tss).toBeGreaterThan(50);
        expect(m.maxPower).toBe(1);
        expect(m.zones.Z5).toBe(25);
    });

    test('a steady hour at FTP is ~100 TSS', () => {
        const m = workoutMetrics({intervals: [steady(1.0, 3600)]});
        expect(m.tss).toBe(100);
        expect(m.if).toBe(1);
    });

    test('describeStructure collapses repeats', () => {
        const s = describeStructure(threshold());
        expect(s).toContain('5x(5min@100%, 5min@50%)');
        expect(s.startsWith('10min@40%→70%')).toBe(true);
    });

    test('summarizeWorkout', () => {
        const s = summarizeWorkout(threshold(), 250);
        expect(s).toMatchObject({name: 'Threshold', minutes: 70, ftp: 250, maxPowerPctFtp: 100});
    });
});

describe('scaleIntensity', () => {
    test('scales power targets and does not mutate input', () => {
        const w = threshold();
        const before = JSON.stringify(w);
        const out = scaleIntensity(w, 90);
        expect(JSON.stringify(w)).toBe(before);
        expect(out.intervals[1].steps[0].power).toBeCloseTo(0.9);
        expect(out.intervals[2].steps[0].power).toBeCloseTo(0.45);
        expect(workoutDuration(out)).toBe(4200);
    });

    test('clamps to limits', () => {
        const out = scaleIntensity(threshold(), 10);
        expect(out.intervals[1].steps[0].power).toBeCloseTo(LIMITS.intensityMin / 100);
        const up = scaleIntensity(threshold(), 150);
        expect(up.intervals[1].steps[0].power).toBeCloseTo(LIMITS.intensityMax / 100);
    });

    test('leaves free ride (power 0) and slope untouched', () => {
        const w = {intervals: [{duration: 60, steps: [{duration: 60, power: 0, slope: 3}]}]};
        const out = scaleIntensity(w, 80);
        expect(out.intervals[0].steps[0]).toEqual({duration: 60, power: 0, slope: 3});
    });
});

describe('shortenWorkout', () => {
    test('splitPhases finds warmup and cooldown', () => {
        const {warmup, main, cooldown} = splitPhases(threshold().intervals);
        expect(warmup.length).toBe(1);
        // the last recovery valley counts toward the cool-down
        expect(main.length).toBe(9);
        expect(cooldown.length).toBe(2);
    });

    test('keeps warmup/cooldown and trims main set from the end', () => {
        const out = shortenWorkout(threshold(), 50);
        expect(workoutDuration(out)).toBe(50 * 60);
        // warmup & cooldown intact
        expect(out.intervals[0].steps[0].power).toBeCloseTo(0.4);
        expect(out.intervals[out.intervals.length - 1].steps[0].power).toBeCloseTo(0.6);
        // 3 full reps (30min) of main set kept
        const hard = out.intervals.filter((i) => i.steps[0].power === 1.0);
        expect(hard.length).toBe(3);
    });

    test('fills remainder with a partial interval when >= 60s', () => {
        const out = shortenWorkout(threshold(), 47);
        expect(workoutDuration(out)).toBeCloseTo(47 * 60, -1);
    });

    test('no-op when target is longer than workout', () => {
        expect(workoutDuration(shortenWorkout(threshold(), 120))).toBe(4200);
    });

    test('compresses everything proportionally when warmup+cooldown exceed target', () => {
        const w = {intervals: [ramp(0.4, 0.7, 1200), steady(1.0, 600), ramp(0.6, 0.4, 900)]};
        const out = shortenWorkout(w, 15);
        expect(Math.abs(workoutDuration(out) - 900)).toBeLessThan(15);
    });

    test('respects minimum duration', () => {
        const out = shortenWorkout(threshold(), 5);
        expect(workoutDuration(out)).toBeGreaterThanOrEqual(LIMITS.minMinutes * 60 - 1);
    });
});

describe('easyWorkout', () => {
    test('builds warmup, steady, cooldown of requested length', () => {
        const w = easyWorkout(60, 0.65);
        expect(workoutDuration(w)).toBeCloseTo(3600, 0);
        expect(w.intervals[1].steps[0].power).toBe(0.65);
        expect(workoutMetrics(w).maxPower).toBeLessThanOrEqual(0.65);
    });
});

describe('sanitizeDecision', () => {
    const w = threshold();

    test('unknown decision falls back to keep', () => {
        const d = sanitizeDecision({decision: 'go_harder'}, w);
        expect(d.decision).toBe('keep');
        expect(d.intensityPercent).toBe(100);
        expect(d.durationMinutes).toBe(70);
    });

    test('clamps intensity and ignores irrelevant numbers', () => {
        expect(sanitizeDecision({decision: 'scale_intensity', intensity_percent: 20, duration_minutes: 10}, w))
            .toMatchObject({intensityPercent: 50, durationMinutes: 70});
        expect(sanitizeDecision({decision: 'shorten', intensity_percent: 80, duration_minutes: 45}, w))
            .toMatchObject({intensityPercent: 100, durationMinutes: 45});
    });

    test('shorten cannot lengthen', () => {
        expect(sanitizeDecision({decision: 'shorten', duration_minutes: 200}, w).durationMinutes).toBe(70);
    });

    test('rest has zero duration', () => {
        expect(sanitizeDecision({decision: 'rest', duration_minutes: 30}, w).durationMinutes).toBe(0);
    });
});

describe('applyDecision', () => {
    const w = threshold();

    test('rest returns null', () => {
        expect(applyDecision(w, sanitizeDecision({decision: 'rest'}, w))).toBeNull();
    });

    test('keep returns a copy with new id and provenance', () => {
        const out = applyDecision(w, sanitizeDecision({decision: 'keep'}, w));
        expect(out).not.toBe(w);
        expect(out.id).not.toBe(w.id);
        expect(out.meta.adjustedFrom).toBe('orig-1');
        expect(out.meta.planned).toBeUndefined();
        expect(workoutDuration(out)).toBe(4200);
    });

    test('scale_and_shorten applies both and updates meta.duration', () => {
        const d = sanitizeDecision({decision: 'scale_and_shorten', intensity_percent: 90, duration_minutes: 50}, w);
        const out = applyDecision(w, d);
        expect(out.meta.duration).toBe(3000);
        expect(out.meta.name).toBe('Threshold (AI: 90%, 50min)');
        expect(workoutMetrics(out).maxPower).toBeCloseTo(0.9);
        // intervals carry recomputed durations
        out.intervals.forEach((i) => expect(i.duration).toBe(i.steps.reduce((a, s) => a + s.duration, 0)));
    });

    test('swap_recovery builds an easy ride', () => {
        const out = applyDecision(w, sanitizeDecision({decision: 'swap_recovery', duration_minutes: 40}, w));
        expect(workoutMetrics(out).maxPower).toBeLessThanOrEqual(0.5);
        expect(Math.round(workoutDuration(out) / 60)).toBe(40);
        expect(out.meta.name).toContain('recovery');
    });

    test('is deterministic', () => {
        const d = sanitizeDecision({decision: 'shorten', duration_minutes: 45}, w);
        const a = applyDecision(w, d);
        const b = applyDecision(w, d);
        expect(a.intervals).toEqual(b.intervals);
    });
});

describe('prompt & schema', () => {
    test('schema is strict and requires every property', () => {
        expect(DECISION_SCHEMA.additionalProperties).toBe(false);
        expect(DECISION_SCHEMA.required.sort()).toEqual(Object.keys(DECISION_SCHEMA.properties).sort());
    });

    test('buildPrompt includes workout, wellness and load', () => {
        const p = buildPrompt({
            date: '2026-10-11',
            workout: threshold(),
            wellness: {hrv: 40, source: 'manual'},
            load: {days: 14, source: 'local', load7d: 300},
        });
        expect(p).toContain('2026-10-11');
        expect(p).toContain('5x(5min@100%, 5min@50%)');
        expect(p).toContain('"hrv": 40');
        expect(p).toContain('source: manual');
        expect(p).toContain('"load7d": 300');
    });
});
