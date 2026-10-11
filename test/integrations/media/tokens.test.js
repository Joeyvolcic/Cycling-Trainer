import {
    normalizeTokenResponse, isExpired, refreshDelay, retryDelay, isFatalRefreshError,
    singleFlight, createRefreshScheduler,
} from '../../../src/integrations/media/tokens.js';

describe('token bookkeeping', () => {
    test('normalizes a token response with absolute expiry', () => {
        const t = normalizeTokenResponse({access_token: 'A', refresh_token: 'R', expires_in: 3600, scope: 's'}, 1000);
        expect(t).toEqual({accessToken: 'A', refreshToken: 'R', scope: 's', tokenType: 'Bearer', expiresAt: 1000 + 3600 * 1000});
    });

    test('keeps the previous refresh token when the refresh response omits it', () => {
        const t = normalizeTokenResponse({access_token: 'B', expires_in: 10}, 0, {refreshToken: 'OLD', scope: 'x'});
        expect(t.refreshToken).toBe('OLD');
        expect(t.scope).toBe('x');
    });

    test('rotated refresh token replaces the old one', () => {
        const t = normalizeTokenResponse({access_token: 'B', refresh_token: 'NEW', expires_in: 10}, 0, {refreshToken: 'OLD'});
        expect(t.refreshToken).toBe('NEW');
    });

    test('throws without access token', () => {
        expect(() => normalizeTokenResponse({})).toThrow();
    });

    test('isExpired applies a skew', () => {
        const token = {accessToken: 'A', expiresAt: 100000};
        expect(isExpired(token, 0)).toBe(false);
        expect(isExpired(token, 100000 - 60000)).toBe(true);
        expect(isExpired(token, 100000 - 60001)).toBe(false);
        expect(isExpired(null, 0)).toBe(true);
    });

    test('refreshDelay schedules one minute before expiry, never below the minimum', () => {
        const token = {accessToken: 'A', refreshToken: 'R', expiresAt: 3600 * 1000};
        expect(refreshDelay(token, 0)).toBe(3600 * 1000 - 60 * 1000);
        expect(refreshDelay(token, 3600 * 1000)).toBe(5000);
        expect(refreshDelay({accessToken: 'A', expiresAt: 1e9}, 0)).toBeNull();
    });

    test('retry backoff doubles and caps', () => {
        expect(retryDelay(0)).toBe(5000);
        expect(retryDelay(1)).toBe(10000);
        expect(retryDelay(3)).toBe(40000);
        expect(retryDelay(20)).toBe(5 * 60 * 1000);
    });

    test('fatal refresh errors', () => {
        expect(isFatalRefreshError(400, {error: 'invalid_grant'})).toBe(true);
        expect(isFatalRefreshError(400, {error: 'invalid_request'})).toBe(false);
        expect(isFatalRefreshError(500, {})).toBe(false);
        expect(isFatalRefreshError(401, {})).toBe(true);
    });
});

describe('singleFlight', () => {
    test('concurrent callers share one call', async () => {
        let calls = 0;
        const f = singleFlight(async () => { calls++; return calls; });
        const [a, b] = await Promise.all([f(), f()]);
        expect(a).toBe(1);
        expect(b).toBe(1);
        expect(await f()).toBe(2);
    });
});

describe('refresh scheduler', () => {
    function setup({refresh}) {
        let now = 0;
        let token = {accessToken: 'A', refreshToken: 'R', expiresAt: 3600 * 1000};
        const timers = [];
        const onFatal = jest.fn();
        const scheduler = createRefreshScheduler({
            getToken: () => token,
            refresh: async () => { token = await refresh(token, now); return token; },
            onFatal,
            now: () => now,
            setTimer: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
            clearTimer: () => {},
        });
        return {scheduler, timers, onFatal, setNow: n => { now = n; }, getToken: () => token};
    }

    test('arms a timer before expiry and re-arms after refresh', async () => {
        const ctx = setup({refresh: async (t, now) => ({accessToken: 'B', refreshToken: 'R', expiresAt: now + 3600 * 1000})});
        expect(ctx.scheduler.schedule()).toBe(3540 * 1000);
        ctx.setNow(3540 * 1000);
        await ctx.timers[0].fn();
        expect(ctx.getToken().accessToken).toBe('B');
        expect(ctx.timers[1].ms).toBe(3540 * 1000);
    });

    test('backs off on transient failure', async () => {
        const ctx = setup({refresh: async () => { throw new Error('network'); }});
        ctx.scheduler.schedule();
        await ctx.timers[0].fn();
        expect(ctx.timers[1].ms).toBe(5000);
        await ctx.timers[1].fn();
        expect(ctx.timers[2].ms).toBe(10000);
        expect(ctx.onFatal).not.toHaveBeenCalled();
    });

    test('stops and reports on fatal failure', async () => {
        const ctx = setup({refresh: async () => { throw Object.assign(new Error('revoked'), {fatal: true}); }});
        ctx.scheduler.schedule();
        await ctx.timers[0].fn();
        expect(ctx.onFatal).toHaveBeenCalled();
        expect(ctx.timers).toHaveLength(1);
        expect(ctx.scheduler.isArmed()).toBe(false);
    });

    test('nothing scheduled without a refresh token', () => {
        const scheduler = createRefreshScheduler({getToken: () => ({accessToken: 'A', expiresAt: 1}), refresh: async () => {}});
        expect(scheduler.schedule()).toBeNull();
    });
});
