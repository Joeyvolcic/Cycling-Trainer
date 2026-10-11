/**
 * @jest-environment jsdom
 */
import {
    buildCatalog, availabilityFromPrefs, planningDays, stepsToWorkout, validatePlan,
    buildPlanPrompt, weekTotals, previewToPlanEntry, mergePlanEntries, upcomingEntries,
    buildChangesPrompt, validateChanges, applyChangesToEntries, adjustedEntryPatch,
    PLAN_SCHEMA, CHANGES_SCHEMA, STEP_LIMITS,
} from '../../../src/integrations/ai/planner-core.js';
import { workoutDuration, workoutMetrics } from '../../../src/integrations/ai/adjust.js';

function steady(power, duration) {
    return {duration, steps: [{duration, power}]};
}

function threshold(id = 'lib-thr', name = 'Threshold 3x10') {
    return {
        id,
        meta: {name, category: 'Threshold', duration: 3600},
        intervals: [steady(0.55, 600), steady(1.0, 600), steady(0.5, 300), steady(1.0, 600),
                    steady(0.5, 300), steady(1.0, 600), steady(0.5, 600)],
    };
}

function endurance(id = 'lib-end', name = 'Endurance 60') {
    return {id, meta: {name, category: 'Endurance', duration: 3600}, intervals: [steady(0.65, 3600)]};
}

const library = [
    threshold(),
    endurance(),
    {id: 'course', meta: {name: 'A course'}, points: [[0, 0]]},                // no intervals
    {id: 'adj', meta: {name: 'Threshold (AI: 90%)', adjustedFrom: 'lib-thr'}, intervals: [steady(0.9, 600)]},
    {id: 'dup', meta: {name: 'endurance 60'}, intervals: [steady(0.6, 600)]}, // duplicate name
];

describe('buildCatalog', () => {
    test('short refs, metrics, skips courses, adjusted copies and duplicates', () => {
        const {catalog, byRef} = buildCatalog(library);
        expect(catalog.map((c) => c.ref)).toEqual(['w1', 'w2']);
        expect(catalog[0]).toMatchObject({name: 'Threshold 3x10', category: 'Threshold', minutes: 60});
        expect(catalog[0].tss).toBeGreaterThan(50);
        expect(catalog[1].if).toBeCloseTo(0.65, 2);
        expect(byRef.get('w2').id).toBe('lib-end');
    });

    test('respects limit', () => {
        const many = Array.from({length: 20}, (_, i) => endurance(`e${i}`, `E${i}`));
        expect(buildCatalog(many, {limit: 5}).catalog).toHaveLength(5);
    });
});

describe('availability', () => {
    test('from calendar prefs windows', () => {
        const a = availabilityFromPrefs({windows: {weekday: [{start: '06:00', end: '07:30'}], 6: [{start: '08:00', end: '11:00'}]}});
        expect(a.days).toEqual([1, 2, 3, 4, 5, 6]);
        expect(a.minutesByWeekday[1]).toBe(90);
        expect(a.minutesByWeekday[6]).toBe(180);
        expect(a.minutesByWeekday[0]).toBe(0);
    });

    test('planningDays spans weeks and marks availability', () => {
        // 2026-10-12 is a Monday
        const days = planningDays({startDate: '2026-10-12', weeks: 2, availableDays: [2, 4, 6],
                                   minutesByWeekday: {2: 60, 4: 60, 6: 180}, maxMinutesPerDay: 120});
        expect(days).toHaveLength(14);
        expect(days[0]).toMatchObject({date: '2026-10-12', name: 'Mon', available: false, maxMinutes: 0});
        expect(days[1]).toMatchObject({date: '2026-10-13', name: 'Tue', available: true, maxMinutes: 60});
        expect(days[5]).toMatchObject({name: 'Sat', maxMinutes: 120});
        expect(planningDays({startDate: '2026-10-12', weeks: 99}).length).toBe(28);
    });
});

describe('stepsToWorkout', () => {
    test('converts steady, ramp and repeats deterministically', () => {
        const w = stepsToWorkout([
            {kind: 'ramp', minutes: 10, power_pct: 45, end_power_pct: 75, repeats: 1, off_minutes: 0, off_power_pct: 0},
            {kind: 'repeats', minutes: 4, power_pct: 115, end_power_pct: 115, repeats: 5, off_minutes: 4, off_power_pct: 50},
            {kind: 'steady', minutes: 10, power_pct: 50, end_power_pct: 50, repeats: 1, off_minutes: 0, off_power_pct: 0},
        ], {name: 'VO2 5x4'});
        expect(w.meta.name).toBe('VO2 5x4');
        expect(w.meta.aiGenerated).toBe(true);
        expect(workoutDuration(w)).toBe(60 * 60);
        expect(w.meta.duration).toBe(3600);
        expect(w.intervals).toHaveLength(1 + 10 + 1);
        expect(w.intervals[0].steps[0].power).toBeCloseTo(0.45);
        expect(w.intervals[0].steps.at(-1).power).toBeCloseTo(0.75);
        expect(w.intervals[1].steps[0]).toEqual({duration: 240, power: 1.15});
        expect(w.intervals[0].duration).toBe(w.intervals[0].steps.reduce((a, s) => a + s.duration, 0));
        expect(w.meta.category).toBeTruthy();
    });

    test('clamps power, durations and repeats; drops garbage', () => {
        const w = stepsToWorkout([
            {kind: 'steady', minutes: 0.01, power_pct: 400},
            {kind: 'steady', minutes: 'abc', power_pct: 50},
            {kind: 'nonsense', minutes: 500, power_pct: 5},
            null,
            {kind: 'repeats', minutes: 1, power_pct: 120, repeats: 1000, off_minutes: -3, off_power_pct: 'x'},
        ], {name: '<b>x</b>\n'.repeat(30)});
        const ss = w.intervals.flatMap((i) => i.steps);
        expect(ss[0]).toEqual({duration: STEP_LIMITS.minStepSec, power: 1.5});
        expect(ss[1]).toEqual({duration: STEP_LIMITS.maxStepMin * 60, power: 0.3});
        const reps = ss.slice(2);
        expect(reps).toHaveLength(STEP_LIMITS.maxRepeats); // off 0 -> no recovery steps
        expect(w.meta.name.length).toBeLessThanOrEqual(60);
        expect(w.meta.name).not.toMatch(/\n/);
    });

    test('caps total duration', () => {
        const w = stepsToWorkout(Array.from({length: 10}, () => ({kind: 'steady', minutes: 60, power_pct: 60})));
        expect(workoutDuration(w)).toBeLessThanOrEqual(STEP_LIMITS.maxTotalMin * 60);
        expect(w.meta.truncated).toBe(true);
    });

    test('returns null without valid steps', () => {
        expect(stepsToWorkout(undefined)).toBeNull();
        expect(stepsToWorkout([{kind: 'steady', minutes: 0, power_pct: 50}])).toBeNull();
    });
});

describe('validatePlan', () => {
    const {catalog, byRef} = buildCatalog(library);
    const days = planningDays({startDate: '2026-10-12', weeks: 1, availableDays: [2, 4, 6],
                               minutesByWeekday: {2: 60, 4: 60, 6: 180}});
    const ctx = {byRef, days, today: '2026-10-12', existing: [{date: '2026-10-15', workoutName: 'Old', status: 'planned'}],
                 weeklyHours: 2};

    const raw = {
        summary: 'Two quality days and a long ride.',
        weekly_focus: ['Threshold'],
        entries: [
            {date: '2026-10-13', workout_ref: 'w1', custom_name: '', steps: [], intensity: 'hard', rationale: 'Fresh after rest.'},
            {date: '2026-10-13', workout_ref: 'w2', custom_name: '', steps: [], intensity: 'easy', rationale: 'dup day'},
            {date: '2026-10-14', workout_ref: 'w1', custom_name: '', steps: [], intensity: 'hard', rationale: 'back to back'},
            {date: '2026-10-15', workout_ref: 'w2', custom_name: '', steps: [], intensity: 'easy', rationale: 'existing'},
            {date: '2026-10-30', workout_ref: 'w2', custom_name: '', steps: [], intensity: 'easy', rationale: 'out of range'},
            {date: 'tomorrow', workout_ref: 'w2', custom_name: '', steps: [], intensity: 'easy', rationale: ''},
            {date: '2026-10-17', workout_ref: 'w999', custom_name: 'Long Z2',
             steps: [{kind: 'steady', minutes: 150, power_pct: 65, end_power_pct: 65, repeats: 1, off_minutes: 0, off_power_pct: 0}],
             intensity: 'easy', rationale: 'Long ride'},
            {date: '2026-10-18', workout_ref: '', custom_name: 'Nothing', steps: [], intensity: 'easy', rationale: ''},
        ],
    };

    const result = validatePlan(raw, ctx);

    test('keeps valid sessions with library snapshot or custom workout', () => {
        expect(result.entries.map((e) => e.date)).toEqual(['2026-10-13', '2026-10-14', '2026-10-17']);
        const [tue, wed, sat] = result.entries;
        expect(tue).toMatchObject({source: 'library', workoutId: 'lib-thr', workoutName: 'Threshold 3x10', durationMin: 60, hard: true});
        expect(tue.workout).not.toBe(byRef.get('w1')); // a copy
        expect(sat.source).toBe('custom');
        expect(sat.workoutName).toBe('Long Z2');
        expect(sat.durationMin).toBe(120); // clamped to maxStepMin
        expect(sat.warnings.join(' ')).toMatch(/Unknown catalog ref/);
        expect(wed.warnings.join(' ')).toMatch(/not one of your available days/);
        expect(wed.warnings.join(' ')).toMatch(/day after another hard/);
    });

    test('reports what was dropped and weekly overload', () => {
        const w = result.warnings.join('\n');
        expect(w).toMatch(/extra session on 2026-10-13/);
        expect(w).toMatch(/2026-10-15: you already have a ride/);
        expect(w).toMatch(/outside the planning period/);
        expect(w).toMatch(/2026-10-18: no valid workout/);
        expect(w).toMatch(/above your 2 h/);
        expect(result.summary).toBe('Two quality days and a long ride.');
    });

    test('tolerates garbage', () => {
        expect(validatePlan(null, ctx).entries).toEqual([]);
        expect(validatePlan({entries: 'x'}, ctx).entries).toEqual([]);
    });

    test('weekTotals skips excluded', () => {
        const entries = result.entries.map((e, i) => Object.assign({}, e, {include: i !== 0}));
        const totals = weekTotals(entries);
        expect(totals).toHaveLength(1);
        expect(totals[0].count).toBe(2);
        expect(totals[0].minutes).toBe(180);
    });

    test('prompt contains catalog refs, days and existing entries', () => {
        const prompt = buildPlanPrompt({today: '2026-10-12', startDate: '2026-10-12', weeks: 1, goal: 'Raise FTP',
            ftp: 250, days, existing: ctx.existing, catalog, load: {source: 'local', activities: [{date: '2026-10-10', minutes: 60}]}});
        expect(prompt).toMatch(/"w1","Threshold 3x10"/);
        expect(prompt).toMatch(/2026-10-13/);
        expect(prompt).toMatch(/Old/);
        expect(prompt).toMatch(/FTP: 250/);
        expect(PLAN_SCHEMA.required).toEqual(['summary', 'weekly_focus', 'entries']);
    });

    test('preview -> plan entries with snapshot; replace mode drops planned in range', () => {
        const pe = previewToPlanEntry(result.entries[0]);
        expect(pe.workout.intervals).toHaveLength(7);
        expect(pe.workout.meta.name).toBe('Threshold 3x10');
        expect(pe).toMatchObject({workoutId: 'lib-thr', status: 'planned', hard: true, date: '2026-10-13'});

        const existing = [
            {id: 'a', date: '2026-10-13', status: 'planned'},
            {id: 'b', date: '2026-10-14', status: 'done'},
            {id: 'c', date: '2026-10-25', status: 'planned'},
        ];
        const merged = mergePlanEntries(existing, result.entries, {replaceExisting: true, from: '2026-10-12', to: '2026-10-18'});
        expect(merged.map((e) => e.id ?? e.date)).toEqual(['b', 'c', '2026-10-13', '2026-10-14', '2026-10-17']);
        expect(mergePlanEntries(existing, [result.entries[0]], {})).toHaveLength(4);
    });
});

describe('coach feedback -> plan changes', () => {
    const thr = threshold();
    const plans = [{
        id: 'plan-1', name: 'Build',
        entries: [
            {id: 'old', date: '2026-10-10', workoutId: 'lib-thr', workoutName: 'Threshold 3x10', status: 'planned'},
            {id: 'e-thr', date: '2026-10-13', workoutId: 'gone-id', workoutName: 'Threshold 3x10', status: 'planned',
             workout: {meta: thr.meta, intervals: thr.intervals}, notes: 'n'},
            {id: 'e-end', date: '2026-10-14', workoutId: 'lib-end', workoutName: 'Endurance 60', status: 'planned'},
            {id: 'e-done', date: '2026-10-15', workoutId: 'lib-end', workoutName: 'Endurance 60', status: 'done'},
            {id: 'e-far', date: '2026-11-30', workoutId: 'lib-end', workoutName: 'Endurance 60', status: 'planned'},
            {id: 'e-missing', date: '2026-10-16', workoutId: 'nope', workoutName: 'Unknown', status: 'planned', durationMin: 45},
        ],
    }];
    const workouts = [endurance()]; // the threshold is only available through its snapshot
    const {catalog, byRef} = buildCatalog([threshold(), endurance()]);
    const today = '2026-10-12';
    const upcoming = upcomingEntries(plans, {today, horizonDays: 14});

    test('upcomingEntries: planned, in horizon, sorted, with refs', () => {
        expect(upcoming.map((u) => [u.ref, u.entry.id])).toEqual([['e1', 'e-thr'], ['e2', 'e-end'], ['e3', 'e-missing']]);
        expect(upcoming[0].planId).toBe('plan-1');
    });

    test('prompt lists refs with summaries resolved from snapshots', () => {
        const prompt = buildChangesPrompt({today, ftp: 250, upcoming, workouts, catalog,
            feedback: {rating: 6, headline: 'Faded', improve: ['pacing'], adjustments: [{when: 'Tue', suggestion: 'easier'}]}});
        expect(prompt).toMatch(/"e1":\{"date":"2026-10-13","workout":"Threshold 3x10","minutes":60/);
        expect(prompt).toMatch(/easier/);
        expect(CHANGES_SCHEMA.properties.changes.items.required).toContain('entry_ref');
    });

    const raw = {
        summary: 'Back off a little.',
        changes: [
            {entry_ref: 'e1', action: 'scale', intensity_percent: 90, duration_minutes: 0, new_date: '', workout_ref: '', reason: 'Faded on rep 3.'},
            {entry_ref: 'e1', action: 'rest', intensity_percent: 100, duration_minutes: 0, new_date: '', workout_ref: '', reason: 'dup'},
            {entry_ref: 'e2', action: 'move', intensity_percent: 100, duration_minutes: 0, new_date: '2026-10-16', workout_ref: '', reason: 'More recovery.'},
            {entry_ref: 'e3', action: 'shorten', intensity_percent: 100, duration_minutes: 30, new_date: '', workout_ref: '', reason: 'x'},
            {entry_ref: 'e9', action: 'rest', intensity_percent: 100, duration_minutes: 0, new_date: '', workout_ref: '', reason: 'x'},
            {entry_ref: 'e3', action: 'explode', intensity_percent: 100, duration_minutes: 0, new_date: '', workout_ref: '', reason: 'x'},
        ],
    };

    test('validateChanges computes before/after deterministically and drops invalid ones', () => {
        const r = validateChanges(raw, {upcoming, byRef, workouts, today});
        expect(r.summary).toBe('Back off a little.');
        expect(r.changes.map((c) => [c.action, c.entryId])).toEqual([['scale', 'e-thr'], ['move', 'e-end']]);
        const [scale, move] = r.changes;
        expect(scale.before).toMatchObject({minutes: 60, name: 'Threshold 3x10'});
        expect(scale.after.tss).toBeLessThan(scale.before.tss);
        expect(Math.max(...scale.workout.intervals.flatMap((i) => i.steps.map((s) => s.power)))).toBeCloseTo(0.9);
        expect(move.newDate).toBe('2026-10-16');
        expect(move.warnings.join(' ')).toMatch(/already has Unknown/);
        const w = r.warnings.join('\n');
        expect(w).toMatch(/second change/);
        expect(w).toMatch(/Shorten" on 2026-10-16: workout not found/);
        expect(w).toMatch(/unknown session "e9"/);
    });

    test('clamps intensity and rejects no-op / far moves / past dates', () => {
        const r = validateChanges({changes: [
            {entry_ref: 'e1', action: 'scale', intensity_percent: 10, reason: ''},
            {entry_ref: 'e2', action: 'move', new_date: '2026-12-31', reason: ''},
        ]}, {upcoming, byRef, workouts, today});
        expect(r.changes[0].decision.intensityPercent).toBe(50);
        expect(r.changes).toHaveLength(1);

        const r2 = validateChanges({changes: [
            {entry_ref: 'e1', action: 'scale', intensity_percent: 100},
            {entry_ref: 'e2', action: 'move', new_date: '2026-10-01'},
            {entry_ref: 'e3', action: 'swap_library', workout_ref: 'w77'},
        ]}, {upcoming, byRef, workouts, today});
        expect(r2.changes).toHaveLength(0);
        expect(r2.warnings).toHaveLength(3);
    });

    test('swaps: library and endurance', () => {
        const r = validateChanges({changes: [
            {entry_ref: 'e1', action: 'swap_endurance', duration_minutes: 45, reason: 'tired'},
            {entry_ref: 'e2', action: 'swap_library', workout_ref: 'w1', reason: 'ready'},
        ]}, {upcoming, byRef, workouts, today});
        expect(r.changes[0].after.minutes).toBe(45);
        expect(workoutMetrics(r.changes[0].workout).if).toBeLessThan(0.7);
        expect(r.changes[1].workout.meta.name).toBe('Threshold 3x10');
    });

    test('applyChangesToEntries patches only selected entries, keeping the original in adjustedFrom', () => {
        const r = validateChanges({changes: [
            raw.changes[0],
            raw.changes[2],
            {entry_ref: 'e3', action: 'rest', reason: 'sick'},
        ]}, {upcoming, byRef, workouts, today});
        const entries = plans[0].entries.map((e) => e.id === 'e-end' ? Object.assign({}, e, {targetTime: '06:00'}) : e);
        const next = applyChangesToEntries(entries, r.changes, {at: 'T'});
        const byId = Object.fromEntries(next.map((e) => [e.id, e]));

        expect(byId.old).toBe(entries[0]); // untouched
        expect(byId['e-thr'].workoutName).toMatch(/AI: 90%/);
        expect(byId['e-thr'].workout.intervals.length).toBeGreaterThan(0);
        expect(byId['e-thr'].adjustedFrom).toMatchObject({workoutId: 'gone-id', workoutName: 'Threshold 3x10', by: 'coach', at: 'T'});
        expect(byId['e-thr'].adjustedFrom.workout.intervals).toHaveLength(7);
        expect(byId['e-thr'].notes).toMatch(/^n\nCoach: Scale intensity — Faded/);
        expect(byId['e-thr'].durationMin).toBe(60);

        expect(byId['e-end'].date).toBe('2026-10-16');
        expect('targetTime' in byId['e-end']).toBe(false);
        expect(byId['e-missing'].status).toBe('skipped');
        expect(entries[1].workoutName).toBe('Threshold 3x10'); // input not mutated
    });

    test('adjustedEntryPatch keeps the first original across repeated adjustments', () => {
        const entry = {id: 'x', workoutId: 'orig', workoutName: 'Orig', notes: ''};
        const first = adjustedEntryPatch(entry, Object.assign(endurance('a1', 'A1')), {by: 'readiness', at: 'T1'});
        const second = adjustedEntryPatch(Object.assign({}, entry, first), endurance('a2', 'A2'), {by: 'coach', at: 'T2', decision: 'shorten'});
        expect(first).toMatchObject({workoutId: 'a1', workoutName: 'A1', durationMin: 60, hard: false});
        expect(second.adjustedFrom).toMatchObject({workoutId: 'orig', by: 'readiness', lastBy: 'coach', lastDecision: 'shorten'});
    });
});
