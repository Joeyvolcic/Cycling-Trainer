/**
 * @jest-environment jsdom
 */

import {
    IntervalsDirect, StravaDirect, Uploaders,
} from '../../../src/integrations/analysis/uploaders.js';

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

const job = {activityId: 'abc', service: 'x', name: 'Ride', blob: new Blob(['fit']), remote: {}};

beforeEach(() => localStorage.clear());

describe('IntervalsDirect', () => {
    test('uses basic auth with API_KEY and the athlete id', async () => {
        localStorage.setItem('analysis:intervals-athlete-id', 'i123');
        localStorage.setItem('analysis:intervals-api-key', 'secret');
        const fetch = jest.fn(async () => response(201, [{icu_athlete_id: 'i123', id: 'i999'}]));
        const res = await IntervalsDirect({fetch}).upload(job);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toMatch(/^https:\/\/intervals\.icu\/api\/v1\/athlete\/i123\/activities\?/);
        expect(url).toContain('external_id=auuki-abc');
        expect(init.headers.Authorization).toBe('Basic ' + btoa('API_KEY:secret'));
        expect(res.remote.url).toBe('https://intervals.icu/activities/i999');
    });

    test('401 needs setup, 503 is retryable, network error is retryable', async () => {
        localStorage.setItem('analysis:intervals-api-key', 'secret');
        await expect(IntervalsDirect({fetch: async () => response(401, {})}).upload(job))
            .rejects.toMatchObject({needsSetup: true, retryable: false});
        await expect(IntervalsDirect({fetch: async () => response(503, {})}).upload(job))
            .rejects.toMatchObject({retryable: true});
        await expect(IntervalsDirect({fetch: async () => { throw new TypeError('Failed to fetch'); }}).upload(job))
            .rejects.toMatchObject({retryable: true});
    });
});

describe('StravaDirect', () => {
    function configure() {
        localStorage.setItem('analysis:strava-client-id', '1');
        localStorage.setItem('analysis:strava-client-secret', 's');
        localStorage.setItem('analysis:strava-refresh-token', 'r');
    }

    test('refreshes token, uploads as trainer, polls and mutes the activity', async () => {
        configure();
        const calls = [];
        const fetch = jest.fn(async (url, init = {}) => {
            calls.push([url, init.method ?? 'GET']);
            if(url.includes('/oauth/token')) return response(200, {access_token: 'at', refresh_token: 'r2', expires_at: 9999999999});
            if(url.endsWith('/uploads')) return response(201, {id: 5, id_str: '5'});
            if(url.includes('/uploads/5')) return response(200, {activity_id: 77});
            if(url.includes('/activities/77')) return response(200, {});
            return response(404, {});
        });
        const progress = jest.fn();
        const res = await StravaDirect({fetch, pollInterval: 0}).upload(job, {progress});
        expect(calls.map(c => c[1])).toEqual(['POST', 'POST', 'GET', 'PUT']);
        const form = fetch.mock.calls[1][1].body;
        expect(form.get('trainer')).toBe('1');
        expect(form.get('data_type')).toBe('fit');
        expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({hide_from_home: true, trainer: true});
        expect(progress).toHaveBeenCalledWith({uploadId: '5'});
        expect(res.remote.hidden).toBe(true);
        expect(localStorage.getItem('analysis:strava-refresh-token')).toBe('r2');
    });

    test('duplicate upload counts as success', async () => {
        configure();
        localStorage.setItem('analysis:strava-access-token', 'at');
        localStorage.setItem('analysis:strava-expires-at', '9999999999');
        const fetch = async (url) => {
            if(url.endsWith('/uploads')) return response(201, {id: 5});
            return response(200, {error: "auuki-abc.fit duplicate of <a href='/activities/123'>Ride</a>"});
        };
        const res = await StravaDirect({fetch, pollInterval: 0}).upload(job);
        expect(res.remote.duplicate).toBe(true);
        expect(res.remote.activityId).toBe('123');
    });

    test('revoked refresh token needs setup', async () => {
        configure();
        const fetch = async () => response(400, {message: 'Bad Request'});
        await expect(StravaDirect({fetch}).upload(job)).rejects.toMatchObject({needsSetup: true});
    });
});

describe('Uploaders.resolve', () => {
    test('prefers direct routes, falls back to the auuki backend', () => {
        const connected = {strava: true, intervals: false, trainingPeaks: false};
        const u = Uploaders({isConnected: (s) => connected[s]});
        expect(u.resolve('strava').route).toBe('auuki');
        expect(u.resolve('intervals')).toBe(null);
        localStorage.setItem('analysis:intervals-api-key', 'k');
        expect(u.resolve('intervals').route).toBe('intervals-direct');
        expect(u.resolve('trainingPeaks')).toBe(null);
    });
});
