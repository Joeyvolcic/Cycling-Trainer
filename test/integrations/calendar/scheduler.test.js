import {
    scheduleEntries, normalizePrefs, normalizeWindows, isHardEntry, formatDate, formatTime,
} from '../../../src/integrations/calendar/scheduler.js';

// 2026-10-12 is a Monday. All times are local.
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';
const THU = '2026-10-15';
const SAT = '2026-10-17';
const now = new Date(2026, 9, 11, 20, 0); // Sunday evening

const prefs = {
    windows: {
        weekday: [{start: '06:00', end: '07:30'}],
        weekend: [{start: '07:00', end: '11:00'}],
    },
    minRestDaysBetweenHard: 1,
    maxShiftDays: 1,
    bufferMin: 0,
    stepMin: 15,
};

function local(dateStr, hh, mm = 0) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, hh, mm);
}

function entry(id, date, extra = {}) {
    return {id, date, workoutId: `w-${id}`, workoutName: 'Endurance', durationMin: 60, status: 'planned', ...extra};
}

describe('normalizeWindows', () => {
    test('expands weekday/weekend shorthands, explicit day keys override', () => {
        const w = normalizeWindows({
            weekday: [{start: '06:00', end: '07:30'}],
            weekend: [{start: '08:00', end: '10:00'}],
            3: [{start: '18:00', end: '20:00'}],
        });
        expect(w[1]).toEqual([{start: 360, end: 450}]);
        expect(w[3]).toEqual([{start: 1080, end: 1200}]);
        expect(w[0]).toEqual([{start: 480, end: 600}]);
        expect(w[6]).toEqual([{start: 480, end: 600}]);
    });

    test('drops invalid windows', () => {
        expect(normalizeWindows({1: [{start: '08:00', end: '07:00'}]})[1]).toEqual([]);
    });

    test('defaults are applied', () => {
        const p = normalizePrefs({});
        expect(p.maxPerDay).toBe(1);
        expect(p.windows[2].length).toBe(1);
    });
});

describe('isHardEntry', () => {
    test('keywords', () => {
        expect(isHardEntry({workoutName: 'VO2max 5x5'})).toBe(true);
        expect(isHardEntry({workoutName: 'Sweet Spot 3x15'})).toBe(true);
        expect(isHardEntry({workoutName: 'Threshold Over-Unders'})).toBe(true);
        expect(isHardEntry({workoutName: 'Endurance Z2'})).toBe(false);
        expect(isHardEntry({workoutName: 'Recovery spin'})).toBe(false);
        expect(isHardEntry({workoutName: 'Endurance', notes: 'easy, recovery after race'})).toBe(false);
    });
    test('explicit fields win', () => {
        expect(isHardEntry({workoutName: 'Endurance', intensity: 'hard'})).toBe(true);
        expect(isHardEntry({workoutName: 'VO2max', hard: false})).toBe(false);
    });
});

describe('scheduleEntries', () => {
    test('places a ride at the start of the weekday window', () => {
        const [r] = scheduleEntries([entry('a', MON)], prefs, {now});
        expect(r.date).toBe(MON);
        expect(r.time).toBe('06:00');
        expect(r.end.getTime() - r.start.getTime()).toBe(60 * 60000);
        expect(r.shiftedDays).toBe(0);
        expect(r.warnings).toEqual([]);
    });

    test('weekend uses the weekend window', () => {
        const [r] = scheduleEntries([entry('a', SAT)], prefs, {now});
        expect(r.time).toBe('07:00');
    });

    test('avoids busy intervals and respects the buffer', () => {
        const busy = [{start: local(MON, 6, 0), end: local(MON, 6, 15)}];
        const [r] = scheduleEntries([entry('a', MON)], {...prefs, bufferMin: 10}, {now, busy});
        // 06:15 is too close with a 10 min buffer, next step is 06:30 (ends 07:30)
        expect(r.time).toBe('06:30');
        expect(r.date).toBe(MON);
    });

    test('accepts ISO strings for busy (google freebusy format)', () => {
        const busy = [{start: local(MON, 5, 0).toISOString(), end: local(MON, 8, 0).toISOString()}];
        const [r] = scheduleEntries([entry('a', MON)], prefs, {now, busy});
        expect(r.date).not.toBe(MON);
    });

    test('shifts to a neighbour day when the day is fully busy', () => {
        const busy = [{start: local(TUE, 0), end: local(TUE, 23, 59)}];
        const [r] = scheduleEntries([entry('a', TUE)], prefs, {now, busy});
        expect(r.date).toBe(WED); // +1 is tried before -1
        expect(r.shiftedDays).toBe(1);
        expect(r.warnings).toContain('shifted');
    });

    test('maxShiftDays 0 means no slot when the day is busy', () => {
        const busy = [{start: local(TUE, 0), end: local(TUE, 23, 59)}];
        const [r] = scheduleEntries([entry('a', TUE)], {...prefs, maxShiftDays: 0}, {now, busy});
        expect(r.start).toBe(null);
        expect(r.reason).toBe('no-free-slot');
    });

    test('rides longer than the window do not fit', () => {
        const [r] = scheduleEntries([entry('a', MON, {durationMin: 120})], {...prefs, maxShiftDays: 0}, {now});
        expect(r.start).toBe(null);
    });

    test('honors targetTime when free, even outside windows', () => {
        const [r] = scheduleEntries([entry('a', MON, {targetTime: '18:30'})], prefs, {now});
        expect(r.time).toBe('18:30');
        expect(r.date).toBe(MON);
    });

    test('falls back to windows when targetTime is busy', () => {
        const busy = [{start: local(MON, 18), end: local(MON, 20)}];
        const [r] = scheduleEntries([entry('a', MON, {targetTime: '18:30'})], prefs, {now, busy});
        expect(r.time).toBe('06:00');
    });

    test('never schedules in the past', () => {
        const morning = new Date(2026, 9, 12, 6, 40); // Monday 06:40, 60 min no longer fits
        const [r] = scheduleEntries([entry('a', MON, {durationMin: 60})], prefs, {now: morning});
        expect(r.date).toBe(TUE);
    });

    test('entries far in the past are reported', () => {
        const [r] = scheduleEntries([entry('a', '2026-09-01')], prefs, {now});
        expect(r.start).toBe(null);
        expect(r.reason).toBe('in-past');
    });

    test('maxPerDay moves a second ride on the same day', () => {
        const res = scheduleEntries([entry('a', MON), entry('b', MON)], prefs, {now});
        expect(res[0].date).toBe(MON);
        expect(res[1].date).toBe(TUE);
    });

    test('hard days are separated by rest days', () => {
        const res = scheduleEntries([
            entry('a', MON, {workoutName: 'VO2max 5x5'}),
            entry('b', TUE, {workoutName: 'Threshold 2x20'}),
        ], prefs, {now});
        expect(res[0].date).toBe(MON);
        expect(res[1].date).toBe(WED);
        expect(res[1].warnings).toContain('shifted');
    });

    test('rest rule counts fixed (already scheduled) hard rides', () => {
        const fixed = [{start: local(TUE, 6), end: local(TUE, 7), hard: true}];
        const [r] = scheduleEntries([entry('a', WED, {workoutName: 'VO2max'})],
                                    {...prefs, maxShiftDays: 1}, {now, fixed});
        expect(r.date).toBe(THU);
    });

    test('relaxes rest rule with a warning when nothing else fits', () => {
        const res = scheduleEntries([
            entry('a', MON, {workoutName: 'VO2max'}),
            entry('b', TUE, {workoutName: 'Threshold'}),
        ], {...prefs, maxShiftDays: 0}, {now});
        expect(res[1].date).toBe(TUE);
        expect(res[1].warnings).toContain('rest-violation');
    });

    test('easy rides are not affected by rest rule', () => {
        const res = scheduleEntries([
            entry('a', MON, {workoutName: 'VO2max'}),
            entry('b', TUE, {workoutName: 'Recovery spin'}),
        ], prefs, {now});
        expect(res[1].date).toBe(TUE);
    });

    test('results are returned in input order', () => {
        const res = scheduleEntries([entry('late', WED), entry('early', MON)], prefs, {now});
        expect(res.map(r => r.entryId)).toEqual(['late', 'early']);
        expect(formatDate(res[1].start)).toBe(MON);
        expect(formatTime(res[0].start)).toBe('06:00');
    });

    test('defaultDurationMin is used when durationMin is missing', () => {
        const [r] = scheduleEntries([{id: 'x', date: SAT}], {...prefs, defaultDurationMin: 90}, {now});
        expect(r.end.getTime() - r.start.getTime()).toBe(90 * 60000);
    });

    test('a week proposed by the AI gets placed', () => {
        const week = [
            entry('1', '2026-10-12', {workoutName: 'Recovery', durationMin: 45}),
            entry('2', '2026-10-13', {workoutName: 'VO2max 5x4', durationMin: 75}),
            entry('3', '2026-10-14', {workoutName: 'Endurance', durationMin: 60}),
            entry('4', '2026-10-15', {workoutName: 'Sweet Spot 3x12', durationMin: 75}),
            entry('5', '2026-10-17', {workoutName: 'Endurance long', durationMin: 180}),
        ];
        const busy = [{start: local(WED, 6, 0), end: local(WED, 9, 0)}];
        const res = scheduleEntries(week, prefs, {now, busy});
        expect(res.every(r => r.start)).toBe(true);
        expect(res[2].date).not.toBe(WED);
        // hard days not adjacent
        const hard = res.filter(r => r.hard).map(r => r.start);
        expect(Math.abs(hard[1] - hard[0])).toBeGreaterThanOrEqual(2 * 20 * 3600000);
        // long ride fits the weekend window
        expect(res[4].date).toBe(SAT);
        expect(res[4].time).toBe('07:00');
    });
});
