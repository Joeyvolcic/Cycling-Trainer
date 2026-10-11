/**
 * @jest-environment jsdom
 */
import {
    getWellness, getRecentLoad, normalizeIntervalsWellness, normalizeManual,
    fromIntervalsHistory, mergeWellness, saveManualWellness, getManualWellness,
    clearManualWellness, setIntervalsKey, normalizeLocalActivity, addDays,
} from '../../../src/integrations/ai/wellness.js';

function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({ok, status, json: () => Promise.resolve(body)});
}

const icuDay = {
    id: '2026-10-11',
    sleepSecs: 25200,
    sleepScore: 82,
    sleepQuality: 2,
    hrv: 48,
    restingHR: 52,
    readiness: 70,
    soreness: 3,
    fatigue: 1,
    stress: 4,
    mood: 1,
    ctl: 60.04,
    atl: 72.5,
    rampRate: 4.21,
    weight: 70,
};

beforeEach(() => {
    localStorage.clear();
    global.fetch = jest.fn();
});

describe('normalization', () => {
    test('intervals.icu record', () => {
        expect(normalizeIntervalsWellness(icuDay)).toEqual({
            date: '2026-10-11',
            sleepScore: 82,
            sleepHours: 7,
            sleepQuality: 4,
            hrv: 48,
            restingHR: 52,
            readiness: 70,
            soreness: 4,
            fatigue: 1,
            stress: 5,
            mood: 5,
            ctl: 60,
            atl: 72.5,
            tsb: -12.5,
            rampRate: 4.2,
        });
    });

    test('drops nulls and uses hrvSDNN fallback', () => {
        expect(normalizeIntervalsWellness({id: 'x', hrv: null, hrvSDNN: 60, restingHR: null}))
            .toEqual({date: 'x', hrv: 60});
    });

    test('manual entry clamps and rounds', () => {
        expect(normalizeManual({sleepHours: '30', sleepQuality: '7', soreness: 0, feel: '3.6', stress: '', notes: '  tired  '}))
            .toEqual({sleepHours: 24, sleepQuality: 5, soreness: 1, feel: 4, notes: 'tired'});
    });

    test('history gives baselines from previous days', () => {
        const r = fromIntervalsHistory([
            {id: '2026-10-09', hrv: 60, restingHR: 48, sleepSecs: 28800},
            {id: '2026-10-10', hrv: 56, restingHR: 50, sleepSecs: 27000},
            icuDay,
        ], '2026-10-11');
        expect(r.hrv).toBe(48);
        expect(r.hrvBaseline).toBe(58);
        expect(r.restingHRBaseline).toBe(49);
        expect(r.sleepHoursAvg).toBe(7.8);
    });

    test('merge: manual overrides and source label', () => {
        expect(mergeWellness({sleepHours: 7, hrv: 50}, {sleepHours: 5, feel: 2}))
            .toEqual({sleepHours: 5, hrv: 50, feel: 2, source: 'intervals.icu+manual'});
        expect(mergeWellness(undefined, undefined)).toEqual({source: 'none'});
        expect(mergeWellness({}, {feel: 3}).source).toBe('manual');
    });

    test('local activity summary', () => {
        const ts = new Date(2026, 9, 10, 18).getTime();
        expect(normalizeLocalActivity({timestamp: ts, duration: 3600, name: 'Ride'}))
            .toEqual({date: '2026-10-10', name: 'Ride', type: 'VirtualRide', minutes: 60});
    });

    test('addDays crosses month boundaries', () => {
        expect(addDays('2026-10-03', -7)).toBe('2026-09-26');
    });
});

describe('manual storage', () => {
    test('save / get / clear', () => {
        saveManualWellness('2026-10-11', {sleepHours: 6.5, feel: 2});
        expect(getManualWellness('2026-10-11')).toEqual({sleepHours: 6.5, feel: 2});
        clearManualWellness('2026-10-11');
        expect(getManualWellness('2026-10-11')).toBeUndefined();
    });
});

describe('getWellness', () => {
    test('direct API key: calls intervals.icu with basic auth and merges manual', async () => {
        setIntervalsKey('secret', 'i123');
        saveManualWellness('2026-10-11', {feel: 2});
        fetch.mockImplementation(() => jsonResponse([icuDay]));

        const w = await getWellness('2026-10-11');

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toBe('https://intervals.icu/api/v1/athlete/i123/wellness?oldest=2026-10-04&newest=2026-10-11');
        expect(opts.headers.Authorization).toBe('Basic ' + btoa('API_KEY:secret'));
        expect(w).toMatchObject({sleepHours: 7, hrv: 48, feel: 2, source: 'intervals.icu+manual'});
    });

    test('defaults athlete id to 0', async () => {
        setIntervalsKey('secret');
        fetch.mockImplementation(() => jsonResponse([]));
        await getWellness('2026-10-11');
        expect(fetch.mock.calls[0][0]).toContain('/athlete/0/wellness');
    });

    test('no key: tries the OAuth proxy with credentials', async () => {
        fetch.mockImplementation(() => jsonResponse([icuDay]));
        const w = await getWellness('2026-10-11');
        const [url, opts] = fetch.mock.calls[0];
        expect(url).toMatch(/\/api\/intervals\/wellness\?oldest=2026-10-04&newest=2026-10-11$/);
        expect(opts).toMatchObject({method: 'POST', credentials: 'include'});
        expect(w.source).toBe('intervals.icu');
    });

    test('failures degrade to manual / none without throwing', async () => {
        fetch.mockImplementation(() => jsonResponse({}, false, 404));
        expect(await getWellness('2026-10-11')).toEqual({source: 'none'});

        fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
        saveManualWellness('2026-10-11', {sleepHours: 8});
        expect(await getWellness('2026-10-11')).toEqual({sleepHours: 8, source: 'manual'});
    });
});

describe('getRecentLoad', () => {
    test('intervals.icu activities with load totals', async () => {
        setIntervalsKey('secret');
        fetch.mockImplementation(() => jsonResponse([
            {start_date_local: '2026-10-10T07:00:00', name: 'VO2', type: 'VirtualRide', moving_time: 3600, icu_training_load: 90, icu_intensity: 92.4},
            {start_date_local: '2026-10-06T07:00:00', name: 'Z2', type: 'Ride', moving_time: 7200, icu_training_load: 100},
            {start_date_local: '2026-09-30T07:00:00', name: 'Old', type: 'Ride', moving_time: 3600, icu_training_load: 50},
        ]));
        const load = await getRecentLoad('2026-10-11');
        expect(fetch.mock.calls[0][0]).toContain('/activities?oldest=2026-09-27&newest=2026-10-10');
        expect(load).toMatchObject({
            source: 'intervals.icu', count7d: 2, minutes7d: 180, load7d: 190, load3d: 90,
            lastActivityDate: '2026-10-10',
        });
        expect(load.activities[0].date).toBe('2026-09-30');
        expect(load.activities[2]).toMatchObject({name: 'VO2', minutes: 60, load: 90, intensity: 92});
    });

    test('falls back to local activities', async () => {
        fetch.mockImplementation(() => jsonResponse({}, false, 403));
        const ts = (d) => new Date(2026, 9, d, 18).getTime();
        const load = await getRecentLoad('2026-10-11', {localActivities: [
            {timestamp: ts(10), duration: 3600, name: 'A'},
            {timestamp: ts(11), duration: 1800, name: 'today, excluded'},
            {timestamp: new Date(2026, 8, 1).getTime(), duration: 3600, name: 'too old'},
        ]});
        expect(load.source).toBe('local');
        expect(load.activities.map((a) => a.name)).toEqual(['A']);
        expect(load.minutes7d).toBe(60);
        expect(load.load7d).toBeUndefined();
    });
});
