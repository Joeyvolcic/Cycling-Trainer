/**
 * @jest-environment jsdom
 */

import indexedDB from 'fake-indexeddb';
import { xf } from '../../src/functions.js';
import { idb } from '../../src/storage/idb.js';
import {
    listPlans, getPlan, savePlan, deletePlan, entriesForDate, updateEntry,
    createPlan, addEntry, addWorkout, removeEntry, moveEntry, reorderEntry,
    duplicateWeek, exportPlan, importPlan, resolveWorkout, hasPlannedToday,
    todayISO, addDays, diffDays, weekStart,
} from '../../src/integrations/plans/plans.js';

window.indexedDB = indexedDB;

describe('training plans', () => {

    global.console = {
        log: jest.fn(),
        error: console.error,
        warn: console.warn,
    };

    const events = [];
    xf.sub('plans:changed', e => events.push(e));

    const workout = {
        id: 'w-1',
        meta: {name: 'Sweet Spot 3x10', duration: 3600, category: 'SweetSpot'},
        intervals: [{duration: 3600, steps: [{duration: 3600, power: 0.9}]}],
    };

    beforeAll(async () => {
        await idb.start('plans-test', 1, ['plans']);
    });

    beforeEach(async () => {
        await idb.clear('plans');
        await listPlans(); // refresh the in-memory cache
        events.length = 0;
    });

    test('date helpers', () => {
        expect(addDays('2026-10-11', 1)).toBe('2026-10-12');
        expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(diffDays('2026-10-05', '2026-10-12')).toBe(7);
        expect(weekStart('2026-10-11')).toBe('2026-10-05'); // Sunday -> Monday before
        expect(weekStart('2026-10-12')).toBe('2026-10-12'); // Monday
        expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('savePlan / getPlan / listPlans / deletePlan', async () => {
        const saved = await savePlan({
            name: 'Base',
            startDate: '2026-10-05',
            entries: [
                {date: '2026-10-07', workoutId: 'w-1', workoutName: 'A'},
                {date: '2026-10-06', workoutId: 'w-2', workoutName: 'B', status: 'bogus'},
            ],
        });

        expect(saved.id).toBeDefined();
        expect(saved.entries.length).toBe(2);
        // sorted by date and normalized
        expect(saved.entries[0].date).toBe('2026-10-06');
        expect(saved.entries[0].status).toBe('planned');
        expect(saved.entries[0].id).toBeDefined();
        expect(events).toEqual([{action: 'save', planId: saved.id}]);

        const got = await getPlan(saved.id);
        expect(got.name).toBe('Base');
        expect(got.entries.map(e => e.workoutName)).toEqual(['B', 'A']);

        await createPlan({name: 'Build', startDate: '2026-11-02'});
        const plans = await listPlans();
        expect(plans.map(p => p.name)).toEqual(['Base', 'Build']);

        await deletePlan(saved.id);
        expect(await getPlan(saved.id)).toBeUndefined();
        expect((await listPlans()).map(p => p.name)).toEqual(['Build']);
        expect(events[events.length - 1]).toEqual({action: 'delete', planId: saved.id});
    });

    test('entriesForDate across plans', async () => {
        const a = await savePlan({name: 'A', entries: [
            {date: '2026-10-11', workoutName: 'one'},
            {date: '2026-10-12', workoutName: 'two'},
        ]});
        const b = await savePlan({name: 'B', entries: [
            {date: '2026-10-11', workoutName: 'three'},
        ]});

        const entries = await entriesForDate('2026-10-11');
        expect(entries.map(e => e.workoutName).sort()).toEqual(['one', 'three']);
        expect(entries.find(e => e.workoutName === 'one').planId).toBe(a.id);
        expect(entries.find(e => e.workoutName === 'three').planName).toBe('B');
        expect(await entriesForDate('2026-01-01')).toEqual([]);
    });

    test('updateEntry', async () => {
        const plan = await savePlan({name: 'A', entries: [{date: '2026-10-11', workoutName: 'one'}]});
        const entryId = plan.entries[0].id;
        events.length = 0;

        const updated = await updateEntry(plan.id, entryId, {status: 'done', activityId: 'act-1', id: 'ignored'});
        expect(updated.id).toBe(entryId);
        expect(updated.status).toBe('done');
        expect(updated.activityId).toBe('act-1');
        expect(events).toEqual([{action: 'entry', planId: plan.id, entryId}]);

        const stored = await getPlan(plan.id);
        expect(stored.entries[0].status).toBe('done');
        expect(stored.entries[0].workoutName).toBe('one');

        await expect(updateEntry(plan.id, 'nope', {})).rejects.toThrow();
        await expect(updateEntry('nope', entryId, {})).rejects.toThrow();
    });

    test('addWorkout snapshots the workout; resolveWorkout falls back', async () => {
        const plan = await createPlan({name: 'A'});
        const entry = await addWorkout(plan.id, workout, '2026-10-11', {targetTime: '18:00'});

        expect(entry.workoutId).toBe('w-1');
        expect(entry.workoutName).toBe('Sweet Spot 3x10');
        expect(entry.durationMin).toBe(60);
        expect(entry.targetTime).toBe('18:00');
        expect(entry.workout.intervals.length).toBe(1);

        expect(resolveWorkout(entry, [workout])).toBe(workout);
        // ids of built-in workouts change between reloads -> match by name
        const renamedId = Object.assign({}, workout, {id: 'other'});
        expect(resolveWorkout(entry, [renamedId])).toBe(renamedId);
        // not in the library -> snapshot
        const snap = resolveWorkout(entry, []);
        expect(snap.meta.name).toBe('Sweet Spot 3x10');
        expect(snap.id).toBe('w-1');
    });

    test('remove, move and reorder entries', async () => {
        const plan = await createPlan({name: 'A'});
        const e1 = await addEntry(plan.id, {date: '2026-10-11', workoutName: 'one'});
        const e2 = await addEntry(plan.id, {date: '2026-10-11', workoutName: 'two'});
        const e3 = await addEntry(plan.id, {date: '2026-10-12', workoutName: 'three'});

        let p = await reorderEntry(plan.id, e2.id, -1);
        expect(p.entries.map(e => e.workoutName)).toEqual(['two', 'one', 'three']);
        // can't move past the day boundary
        p = await reorderEntry(plan.id, e1.id, +1);
        expect(p.entries.map(e => e.workoutName)).toEqual(['two', 'one', 'three']);

        p = await moveEntry(plan.id, e3.id, '2026-10-10');
        expect(p.entries.map(e => [e.workoutName, e.date])).toEqual([
            ['three', '2026-10-10'], ['two', '2026-10-11'], ['one', '2026-10-11'],
        ]);

        p = await removeEntry(plan.id, e1.id);
        expect(p.entries.map(e => e.workoutName)).toEqual(['three', 'two']);
    });

    test('duplicateWeek', async () => {
        const plan = await savePlan({name: 'A', startDate: '2026-10-05', entries: [
            {date: '2026-10-05', workoutName: 'mon', status: 'done', activityId: 'x', calendarEventId: 'c'},
            {date: '2026-10-08', workoutName: 'thu'},
            {date: '2026-10-12', workoutName: 'next mon'},
        ]});

        const p = await duplicateWeek(plan.id, '2026-10-05');
        const copies = p.entries.filter(e => e.date >= '2026-10-12' && e.workoutName !== 'next mon');
        expect(copies.map(e => [e.workoutName, e.date])).toEqual([
            ['mon', '2026-10-12'], ['thu', '2026-10-15'],
        ]);
        expect(copies[0].status).toBe('planned');
        expect(copies[0].activityId).toBeUndefined();
        expect(copies[0].calendarEventId).toBeUndefined();
        expect(p.entries.length).toBe(5);
    });

    test('export / import', async () => {
        const plan = await savePlan({name: 'A', goal: 'FTP 300', entries: [
            {date: '2026-10-11', workoutName: 'one', calendarEventId: 'c'},
        ]});
        const json = exportPlan(plan);
        const imported = await importPlan(json);

        expect(imported.id).not.toBe(plan.id);
        expect(imported.name).toBe('A');
        expect(imported.goal).toBe('FTP 300');
        expect(imported.entries[0].id).not.toBe(plan.entries[0].id);
        expect(imported.entries[0].calendarEventId).toBeUndefined();
        expect((await listPlans()).length).toBe(2);

        await expect(importPlan('{"foo": 1}')).rejects.toThrow();
    });

    test('hasPlannedToday uses the cache', async () => {
        const plan = await savePlan({name: 'A', entries: [{date: todayISO(), workoutName: 'today'}]});
        expect(hasPlannedToday()).toBe(true);
        await updateEntry(plan.id, plan.entries[0].id, {status: 'skipped'});
        expect(hasPlannedToday()).toBe(false);
        await deletePlan(plan.id);
        expect(hasPlannedToday()).toBe(false);
    });
});
