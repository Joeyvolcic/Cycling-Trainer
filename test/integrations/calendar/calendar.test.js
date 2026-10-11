/**
 * @jest-environment jsdom
 */

import indexedDB from 'fake-indexeddb';
import { xf } from '../../../src/functions.js';
import { idb } from '../../../src/storage/idb.js';
import * as plans from '../../../src/integrations/plans/plans.js';
import * as calendar from '../../../src/integrations/calendar/calendar.js';

window.indexedDB = indexedDB;

describe('calendar public api', () => {
    beforeAll(async () => {
        await idb.start('calendar-test', 1, ['plans']);
    });

    beforeEach(async () => {
        localStorage.clear();
        await idb.clear('plans');
        await plans.listPlans(); // refresh the in-memory cache
    });

    test('scheduleEntries uses saved prefs merged with overrides (no google)', async () => {
        calendar.savePrefs({windows: {weekday: [{start: '18:00', end: '20:00'}]}});
        const res = await calendar.scheduleEntries(
            [{id: 'a', date: '2026-10-13', workoutName: 'Endurance', durationMin: 60}],
            {bufferMin: 0},
            {now: new Date(2026, 9, 11)});
        expect(res[0].date).toBe('2026-10-13');
        expect(res[0].time).toBe('18:00');
    });

    test('buildIcs exports planned entries from all plans', async () => {
        const today = new Date();
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const later = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
        await plans.savePlan({id: 'p', name: 'P', entries: [
            {id: 'e1', date: iso(later), workoutName: 'Endurance', durationMin: 60, status: 'planned'},
            {id: 'e2', date: iso(later), workoutName: 'Skipped', durationMin: 60, status: 'skipped'},
        ]});
        const {text, count} = await calendar.buildIcs();
        expect(count).toBe(1);
        expect(text).toContain('SUMMARY:Endurance');
        expect(text).not.toContain('Skipped');
    });

    test('deep link resolves planEntry to its workout and selects it', async () => {
        await plans.savePlan({id: 'p', name: 'P', entries: [
            {id: 'e1', date: '2026-10-13', workoutId: 'w1', workoutName: 'X', status: 'planned'},
        ]});
        const events = [];
        xf.sub('calendar:opened-entry', (x) => events.push(x));
        const pages = [];
        xf.sub('ui:page-set', (x) => pages.push(x));
        await calendar.openFromLink({planEntry: 'e1', plan: 'p'});
        expect(events[0]).toEqual({planId: 'p', entryId: 'e1', workoutId: 'w1'});
        expect(pages).toContain('home');
    });

    test('plans module implements the contract', async () => {
        await plans.savePlan({id: 'p', entries: [{id: 'e', date: '2026-10-13'}]});
        expect((await plans.listPlans()).length).toBe(1);
        expect((await plans.entriesForDate('2026-10-13'))[0].id).toBe('e');
        await plans.updateEntry('p', 'e', {calendarEventId: 'x'});
        expect((await plans.getPlan('p')).entries[0].calendarEventId).toBe('x');
        await plans.deletePlan('p');
        expect(await plans.listPlans()).toEqual([]);
    });
});
