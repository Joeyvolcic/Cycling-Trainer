import {
    buildCoachRequest, normalizeFeedback, requestFeedback, compactWorkout,
} from '../../../src/integrations/analysis/coach.js';

const summary = {ftp: 250, durationSec: 3600, power: {avg: 200, normalized: 220}};
const workout = {
    meta: {name: 'Sweet Spot'},
    intervals: [
        {duration: 600, steps: [{duration: 300, power: 0.5}, {duration: 300, power: 0.7}]},
        {duration: 1200, steps: [{duration: 1200, power: 0.9, cadence: 90}]},
    ],
};

describe('coach', () => {
    test('compactWorkout expresses targets as %FTP', () => {
        const c = compactWorkout(workout, 250);
        expect(c.intervals[0].targetPctFtp).toEqual([50, 70]);
        expect(c.intervals[1].targetPctFtp).toBe(90);
        expect(c.intervals[1].cadence).toBe(90);
    });

    test('prompt includes the summary, the plan and asks for a 1-10 rating', () => {
        const {system, prompt} = buildCoachRequest({summary, workout, planContext: {upcoming: [{date: '2026-10-12', workoutName: 'VO2'}]}});
        expect(system).toMatch(/coach/i);
        expect(prompt).toContain('"normalized": 220');
        expect(prompt).toContain('Sweet Spot');
        expect(prompt).toContain('VO2');
        expect(prompt).toMatch(/1 to 10/);
    });

    test('normalizeFeedback clamps and coerces', () => {
        const f = normalizeFeedback({rating: 14, wentWell: 'steady', improve: ['a'], adjustments: ['rest day']});
        expect(f.rating).toBe(10);
        expect(f.wentWell).toEqual(['steady']);
        expect(f.adjustments).toEqual([{when: '', suggestion: 'rest day'}]);
        expect(normalizeFeedback('not json').text).toBe('not json');
        expect(normalizeFeedback('```json\n{"rating": 7}\n```').rating).toBe(7);
    });

    test('requestFeedback uses the AI client in json mode', async () => {
        const ai = {
            isConfigured: () => true,
            complete: jest.fn(async () => ({rating: 8, headline: 'Solid', wentWell: ['x'], improve: [], adjustments: []})),
        };
        const f = await requestFeedback(ai, {summary, workout});
        expect(ai.complete.mock.calls[0][0].json).toBe(true);
        expect(f.rating).toBe(8);
        expect(f.source).toBe('claude');
    });

    test('requestFeedback refuses when not configured', async () => {
        await expect(requestFeedback({isConfigured: () => false}, {summary})).rejects.toThrow();
    });
});
