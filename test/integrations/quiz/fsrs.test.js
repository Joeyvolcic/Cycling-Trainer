import {
    Rating, State, MINUTE, DAY, newSrs, retrievability, initDifficulty,
    nextDifficulty, nextInterval, review, preview, formatInterval, defaultParams,
} from '../../../src/integrations/quiz/fsrs.js';

const T0 = Date.UTC(2026, 0, 1, 12);

describe('FSRS primitives', () => {
    test('retrievability is 0.9 after exactly S days and decays monotonically', () => {
        expect(retrievability(0, 5)).toBeCloseTo(1, 6);
        expect(retrievability(5, 5)).toBeCloseTo(0.9, 6);
        expect(retrievability(10, 5)).toBeLessThan(0.9);
        expect(retrievability(3, 0)).toBe(0);
    });

    test('initial difficulty: Again hardest, Easy easiest, clamped 1..10', () => {
        const ds = [1, 2, 3, 4].map(g => initDifficulty(defaultParams.w, g));
        expect(ds[0]).toBeGreaterThan(ds[1]);
        expect(ds[1]).toBeGreaterThan(ds[2]);
        expect(ds[2]).toBeGreaterThan(ds[3]);
        ds.forEach(d => { expect(d).toBeGreaterThanOrEqual(1); expect(d).toBeLessThanOrEqual(10); });
    });

    test('difficulty rises on Again and falls on Easy', () => {
        expect(nextDifficulty(defaultParams.w, 5, Rating.again)).toBeGreaterThan(5);
        expect(nextDifficulty(defaultParams.w, 5, Rating.easy)).toBeLessThan(5);
    });

    test('interval at 90% retention equals stability (rounded), min 1 day, max cap', () => {
        const p = defaultParams;
        expect(nextInterval(p, 10)).toBe(10);
        expect(nextInterval(p, 0.2)).toBe(1);
        expect(nextInterval(p, 1e9)).toBe(p.maximumInterval);
        expect(nextInterval(Object.assign({}, p, {requestRetention: 0.8}), 10)).toBeGreaterThan(10);
    });

    test('invalid rating throws', () => {
        expect(() => review(newSrs(T0), 5, T0)).toThrow();
    });
});

describe('FSRS scheduling: new and learning cards', () => {
    test('new + Again -> learning step 0 (1 minute)', () => {
        const { srs, log } = review(newSrs(T0), Rating.again, T0);
        expect(srs.state).toBe(State.learning);
        expect(srs.step).toBe(0);
        expect(srs.due).toBe(T0 + 1 * MINUTE);
        expect(srs.reps).toBe(1);
        expect(log.state).toBe(State.new);
    });

    test('new + Good -> next learning step (10 minutes)', () => {
        const { srs } = review(newSrs(T0), Rating.good, T0);
        expect(srs.state).toBe(State.learning);
        expect(srs.step).toBe(1);
        expect(srs.due).toBe(T0 + 10 * MINUTE);
    });

    test('new + Hard -> halfway between first two steps', () => {
        const { srs } = review(newSrs(T0), Rating.hard, T0);
        expect(srs.due).toBe(T0 + 5.5 * MINUTE);
    });

    test('new + Easy graduates straight to review with >= 1 day', () => {
        const { srs } = review(newSrs(T0), Rating.easy, T0);
        expect(srs.state).toBe(State.review);
        expect(srs.scheduledDays).toBeGreaterThanOrEqual(1);
        expect(srs.due).toBe(T0 + srs.scheduledDays * DAY);
    });

    test('learning Good on last step graduates to review', () => {
        let { srs } = review(newSrs(T0), Rating.good, T0);
        ({ srs } = review(srs, Rating.good, T0 + 10 * MINUTE));
        expect(srs.state).toBe(State.review);
        expect(srs.scheduledDays).toBeGreaterThanOrEqual(1);
    });

    test('does not mutate input', () => {
        const s0 = newSrs(T0);
        const copy = JSON.parse(JSON.stringify(s0));
        review(s0, Rating.good, T0);
        expect(s0).toEqual(copy);
    });
});

function graduate(rating = Rating.good) {
    let { srs } = review(newSrs(T0), Rating.good, T0);
    ({ srs } = review(srs, rating, T0 + 10 * MINUTE));
    return srs;
}

describe('FSRS scheduling: reviews and lapses', () => {
    test('successful reviews grow intervals', () => {
        let srs = graduate();
        let t = srs.due;
        const intervals = [srs.scheduledDays];
        for(let i = 0; i < 4; i++) {
            ({ srs } = review(srs, Rating.good, t));
            intervals.push(srs.scheduledDays);
            t = srs.due;
        }
        for(let i = 1; i < intervals.length; i++) {
            expect(intervals[i]).toBeGreaterThan(intervals[i - 1]);
        }
    });

    test('review intervals are ordered hard <= good < easy', () => {
        const srs = graduate();
        const now = srs.due;
        const hard = review(srs, Rating.hard, now).srs.scheduledDays;
        const good = review(srs, Rating.good, now).srs.scheduledDays;
        const easy = review(srs, Rating.easy, now).srs.scheduledDays;
        expect(hard).toBeLessThanOrEqual(good);
        expect(good).toBeLessThan(easy);
    });

    test('lapse: Again in review -> relearning, lapses++, stability drops', () => {
        let srs = graduate();
        ({ srs } = review(srs, Rating.good, srs.due));
        const before = srs.stability;
        const { srs: lapsed } = review(srs, Rating.again, srs.due);
        expect(lapsed.state).toBe(State.relearning);
        expect(lapsed.lapses).toBe(1);
        expect(lapsed.stability).toBeLessThan(before);
        expect(lapsed.due).toBe(srs.due + 10 * MINUTE);
        expect(lapsed.difficulty).toBeGreaterThan(srs.difficulty);
    });

    test('relearning Good returns to review with a short interval', () => {
        let srs = graduate();
        ({ srs } = review(srs, Rating.good, srs.due));
        const lapseAt = srs.due;
        ({ srs } = review(srs, Rating.again, lapseAt));
        ({ srs } = review(srs, Rating.good, srs.due));
        expect(srs.state).toBe(State.review);
        expect(srs.lapses).toBe(1);
        expect(srs.scheduledDays).toBeGreaterThanOrEqual(1);
    });

    test('lapse with no relearning steps stays in review', () => {
        let srs = graduate();
        const { srs: lapsed } = review(srs, Rating.again, srs.due, { relearningSteps: [] });
        expect(lapsed.state).toBe(State.review);
        expect(lapsed.lapses).toBe(1);
    });

    test('preview returns increasing delays per rating', () => {
        const srs = graduate();
        const p = preview(srs, srs.due);
        expect(p[1]).toBeLessThan(p[2]);
        expect(p[2]).toBeLessThanOrEqual(p[3]);
        expect(p[3]).toBeLessThan(p[4]);
    });

    test('formatInterval', () => {
        expect(formatInterval(30 * 1000)).toBe('<1m');
        expect(formatInterval(10 * MINUTE)).toBe('10m');
        expect(formatInterval(3 * DAY)).toBe('3d');
        expect(formatInterval(400 * DAY)).toBe('1.1y');
    });
});
