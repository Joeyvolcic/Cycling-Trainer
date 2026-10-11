/**
 * @jest-environment jsdom
 */
// Render smoke tests for <x-ai-planner> / <x-ai-plan-changes> (Claude mocked).
import indexedDB from 'fake-indexeddb';

jest.mock('../../../src/integrations/ai/claude.js', () => ({
    isConfigured: jest.fn(() => true),
    complete: jest.fn(),
    getModel: jest.fn(() => 'claude-opus-5-5'),
    getKey: jest.fn(() => ''), setKey: jest.fn(), clearKey: jest.fn(), setModel: jest.fn(), MODELS: [],
}));
jest.mock('../../../src/integrations/calendar/calendar.js', () => ({
    scheduleEntries: jest.fn(async () => []), syncAll: jest.fn(async () => []),
    exportIcs: jest.fn(async () => 0), loadPrefs: jest.fn(() => ({})),
}));
jest.mock('../../../src/integrations/calendar/google.js', () => ({isConfigured: () => false, isConnected: () => false}));
jest.mock('../../../src/models/models.js', () => ({models: {planned: {list: () => []}}}));

import { idb } from '../../../src/storage/idb.js';
import { session, proposals } from '../../../src/integrations/ai/planner-view.js';
import { stepsToWorkout } from '../../../src/integrations/ai/planner-core.js';

window.indexedDB = indexedDB;

describe('planner views', () => {
    // jsdom's CSS parser does not understand @container and logs an error
    global.console = {log: jest.fn(), error: jest.fn(), warn: jest.fn()};

    beforeAll(async () => {
        await idb.start('planner-view-test', 1, ['plans', 'activity']);
    });

    test('form has 44px day toggles and a submit', () => {
        const el = document.createElement('x-ai-planner');
        document.body.appendChild(el);
        expect(el.querySelectorAll('[data-action="toggle-day"]')).toHaveLength(7);
        expect(el.querySelector('button[type="submit"]').disabled).toBe(false);
        const before = session.form.days.includes(1);
        el.querySelector('[data-day="1"]').click();
        expect(session.form.days.includes(1)).toBe(!before);
        expect(el.querySelector('[data-day="1"]').classList.contains('selected')).toBe(!before);
        el.remove();
    });

    test('preview renders a week grid with include checkboxes', () => {
        const workout = stepsToWorkout([{kind: 'steady', minutes: 60, power_pct: 65}], {name: 'Z2'});
        const days = Array.from({length: 7}, (_, i) => ({date: `2026-10-${12 + i}`, name: 'x', weekday: (i + 1) % 7, available: i % 2 === 1, maxMinutes: 60}));
        session.status = 'preview';
        session.preview = {
            form: {}, model: 'claude-opus-5-5', from: days[0].date, to: days[6].date, days,
            existing: [{date: '2026-10-14', workoutName: 'Old ride', status: 'planned'}],
            summary: 'Plan', weeklyFocus: ['Base'], warnings: ['w'],
            entries: [{key: 'p0', date: '2026-10-13', workout, workoutName: 'Z2', source: 'custom', durationMin: 60, tss: 42,
                       hard: false, notes: '', warnings: [], include: true}],
        };
        const el = document.createElement('x-ai-planner');
        document.body.appendChild(el);
        expect(el.querySelectorAll('.aip-day')).toHaveLength(7);
        expect(el.textContent).toMatch(/Planned: Old ride/);
        const box = el.querySelector('[data-action="include"]');
        box.click();
        expect(session.preview.entries[0].include).toBe(false);
        expect(el.querySelector('[data-action="accept"]').disabled).toBe(true);
        el.remove();
    });

    test('plan changes renders a diff with per-change checkboxes', () => {
        proposals.set('act-1', {status: 'ready', result: {summary: 's', warnings: [], changes: [
            {id: 'c0', action: 'scale', label: 'Scale intensity', planName: 'P', reason: 'r', warnings: [], selected: true,
             before: {date: '2026-10-13', name: 'A', minutes: 60, tss: 70}, after: {date: '2026-10-13', name: 'A (AI: 90%)', minutes: 60, tss: 57}},
        ]}});
        const el = document.createElement('x-ai-plan-changes');
        el.dataset.activityId = 'act-1';
        document.body.appendChild(el);
        expect(el.querySelectorAll('input[data-action="select"]')).toHaveLength(1);
        expect(el.querySelector('.aip-before').textContent).toMatch(/TSS 70/);
        el.querySelector('input[data-action="select"]').click();
        expect(proposals.get('act-1').result.changes[0].selected).toBe(false);
        el.remove();
    });
});
