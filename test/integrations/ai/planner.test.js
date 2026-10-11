/**
 * @jest-environment jsdom
 */
// Orchestration with a mocked Claude client (never the real API), mocked
// calendar / wellness, and the real plans module on fake-indexeddb.
import indexedDB from 'fake-indexeddb';

jest.mock('../../../src/integrations/ai/claude.js', () => ({
    isConfigured: jest.fn(() => true),
    complete: jest.fn(),
    getModel: jest.fn(() => 'claude-opus-5-5'),
}));
jest.mock('../../../src/integrations/ai/wellness.js', () => ({
    getWellness: jest.fn(async () => ({source: 'manual', sleepHours: 7})),
    getRecentLoad: jest.fn(async () => ({source: 'local', days: 14, activities: []})),
    getIntervalsPlanned: jest.fn(async () => []),
    isoDate: () => '2026-10-12',
}));
jest.mock('../../../src/integrations/calendar/calendar.js', () => ({
    scheduleEntries: jest.fn(async (entries) => entries.map((e) => ({
        entryId: e.id, date: e.date, time: '06:15', start: new Date(), end: new Date(), shiftedDays: 0, warnings: [],
    }))),
    syncAll: jest.fn(async () => []),
    exportIcs: jest.fn(async () => 0),
    loadPrefs: jest.fn(() => ({windows: {weekday: [{start: '06:00', end: '07:30'}], weekend: [{start: '07:00', end: '10:00'}]}})),
}));
jest.mock('../../../src/integrations/calendar/google.js', () => ({
    isConfigured: jest.fn(() => true),
    isConnected: jest.fn(() => false),
}));
jest.mock('../../../src/models/models.js', () => ({models: {planned: {list: () => []}}}));

import { xf } from '../../../src/functions.js';
import { idb } from '../../../src/storage/idb.js';
import * as plans from '../../../src/integrations/plans/plans.js';
import * as claude from '../../../src/integrations/ai/claude.js';
import * as calendar from '../../../src/integrations/calendar/calendar.js';
import * as google from '../../../src/integrations/calendar/google.js';
import { state, acceptResult } from '../../../src/integrations/ai/readiness.js';
import { applyDecision, sanitizeDecision } from '../../../src/integrations/ai/adjust.js';
import {
    proposePlan, acceptPlan, proposeChanges, applyChanges, defaultForm,
} from '../../../src/integrations/ai/planner.js';

window.indexedDB = indexedDB;

function steady(power, duration) {
    return {duration, steps: [{duration, power}]};
}
const thr = {id: 'lib-thr', meta: {name: 'Threshold 3x10', category: 'Threshold'},
             intervals: [steady(0.55, 600), steady(1.0, 600), steady(0.5, 300), steady(1.0, 600), steady(0.5, 600)]};
const end = {id: 'lib-end', meta: {name: 'Endurance 60', category: 'Endurance'}, intervals: [steady(0.65, 3600)]};

describe('AI planner orchestration', () => {
    global.console = {log: jest.fn(), error: console.error, warn: jest.fn()};

    beforeAll(async () => {
        await idb.start('planner-test', 1, ['plans']);
    });

    beforeEach(async () => {
        await idb.clear('plans');
        await plans.listPlans();
        state.ftp = 250;
        state.workouts = [thr, end];
        state.activity = [];
        claude.complete.mockReset();
        calendar.syncAll.mockClear();
        calendar.scheduleEntries.mockClear();
        google.isConnected.mockReturnValue(false);
    });

    function form(extra = {}) {
        const today = plans.todayISO();
        return Object.assign(defaultForm(), {startDate: today, weeks: 1, days: [0, 1, 2, 3, 4, 5, 6]}, extra);
    }

    test('defaultForm derives availability from calendar prefs', () => {
        const f = defaultForm();
        expect(f.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(f.weekdayMinutes).toBe(90);
        expect(f.weekendMinutes).toBe(180);
        expect(f.ftp).toBe(250);
    });

    test('proposePlan sends schema + catalog; acceptPlan writes snapshots, times and offers .ics', async () => {
        const d0 = plans.todayISO();
        const d1 = plans.addDays(d0, 1);
        claude.complete.mockResolvedValue({
            summary: 'ok', weekly_focus: ['base'],
            entries: [
                {date: d0, workout_ref: 'w2', custom_name: '', steps: [], intensity: 'easy', rationale: 'easy start'},
                {date: d1, workout_ref: '', custom_name: 'Over-unders', intensity: 'hard', rationale: 'custom',
                 steps: [{kind: 'repeats', minutes: 3, power_pct: 105, end_power_pct: 105, repeats: 4, off_minutes: 2, off_power_pct: 88}]},
            ],
        });

        const preview = await proposePlan(form());
        const args = claude.complete.mock.calls[0][0];
        expect(args.json).toBe(true);
        expect(args.schema.required).toEqual(['summary', 'weekly_focus', 'entries']);
        expect(args.effort).toBe('medium');
        expect(args.prompt).toMatch(/"w1","Threshold 3x10"/);
        expect(preview.entries).toHaveLength(2);

        const out = await acceptPlan(preview);
        expect(out.added).toBe(2);
        expect(out.synced).toBe(false);
        expect(out.needsIcs).toBe(true);
        expect(calendar.syncAll).not.toHaveBeenCalled();

        const saved = (await plans.listPlans())[0];
        expect(saved.entries).toHaveLength(2);
        const [a, b] = saved.entries;
        expect(a).toMatchObject({workoutId: 'lib-end', workoutName: 'Endurance 60', targetTime: '06:15', status: 'planned'});
        expect(a.workout.intervals).toHaveLength(1);
        expect(b.workoutName).toBe('Over-unders');
        expect(b.workout.meta.aiGenerated).toBe(true);
        // resolvable without the library (id churn)
        expect(plans.resolveWorkout(b, []).intervals.length).toBe(8);
    });

    test('acceptPlan syncs when Google is connected and respects excluded entries', async () => {
        google.isConnected.mockReturnValue(true);
        claude.complete.mockResolvedValue({summary: '', weekly_focus: [], entries: [
            {date: plans.todayISO(), workout_ref: 'w1', custom_name: '', steps: [], intensity: 'hard', rationale: ''},
            {date: plans.addDays(plans.todayISO(), 2), workout_ref: 'w2', custom_name: '', steps: [], intensity: 'easy', rationale: ''},
        ]});
        const preview = await proposePlan(form());
        preview.entries[1].include = false;
        const out = await acceptPlan(preview);
        expect(out.added).toBe(1);
        expect(out.synced).toBe(true);
        expect(calendar.syncAll).toHaveBeenCalledTimes(1);
    });

    test('coach changes: propose -> apply selected via plans module', async () => {
        const today = plans.todayISO();
        const plan = await plans.createPlan({name: 'Build', entries: [
            plans.entryFromWorkout(thr, plans.addDays(today, 1)),
            plans.entryFromWorkout(end, plans.addDays(today, 2)),
        ]});
        claude.complete.mockResolvedValue({summary: 'ease off', changes: [
            {entry_ref: 'e1', action: 'shorten', intensity_percent: 100, duration_minutes: 30, new_date: '', workout_ref: '', reason: 'fatigue'},
            {entry_ref: 'e2', action: 'rest', intensity_percent: 100, duration_minutes: 0, new_date: '', workout_ref: '', reason: 'recover'},
        ]});
        const proposal = await proposeChanges({feedback: {rating: 5, adjustments: [{when: 'next', suggestion: 'shorter'}]}});
        expect(claude.complete.mock.calls[0][0].schema.required).toEqual(['summary', 'changes']);
        expect(proposal.changes).toHaveLength(2);
        proposal.changes[1].selected = false;

        const out = await applyChanges(proposal.changes);
        expect(out.needsIcs).toBe(true);
        const saved = await plans.getPlan(plan.id);
        const [a, b] = saved.entries;
        expect(a.durationMin).toBeLessThanOrEqual(30);
        expect(a.adjustedFrom).toMatchObject({workoutId: 'lib-thr', by: 'coach'});
        expect(b.status).toBe('planned'); // not selected
    });

    test('proposeChanges without upcoming entries does not call Claude', async () => {
        const r = await proposeChanges({feedback: {}});
        expect(r.empty).toBe(true);
        expect(claude.complete).not.toHaveBeenCalled();
    });

    test('readiness accept saves the adjusted workout to the library and links it from the entry', async () => {
        const today = plans.todayISO();
        const plan = await plans.createPlan({name: 'P', entries: [plans.entryFromWorkout(thr, today)]});
        const entry = Object.assign({}, plan.entries[0], {planId: plan.id});
        const decision = sanitizeDecision({decision: 'scale_intensity', intensity_percent: 90, rationale: 'tired'}, thr);
        const adjusted = applyDecision(thr, decision);
        const result = {id: 'r1', date: today, decision, original: thr, adjusted, after: {minutes: 45}};

        const saves = [];
        const rides = [];
        const ac = new AbortController();
        xf.sub('ui:workout:save', (w) => saves.push(w), {signal: ac.signal});
        xf.sub('ui:plans:ride', (x) => rides.push(x), {signal: ac.signal});

        await acceptResult(result, {entry});
        ac.abort();

        expect(saves).toHaveLength(1);
        expect(saves[0].id).toBe(adjusted.id);
        expect(saves[0].meta.adjustedFrom).toBe('lib-thr');
        expect(rides).toEqual([{planId: plan.id, entryId: entry.id}]);

        const saved = (await plans.getPlan(plan.id)).entries[0];
        expect(saved.workoutId).toBe(adjusted.id);
        expect(saved.workoutName).toMatch(/AI: 90%/);
        expect(saved.workout.intervals).toEqual(adjusted.intervals);
        expect(saved.adjustedFrom).toMatchObject({workoutId: 'lib-thr', workoutName: 'Threshold 3x10', by: 'readiness'});
        expect(saved.notes).toMatch(/AI readiness: scale intensity/);
    });
});
