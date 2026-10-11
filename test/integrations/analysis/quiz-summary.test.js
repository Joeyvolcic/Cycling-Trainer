/**
 * @jest-environment jsdom
 */

// quiz:ride-summary is attached to the saved activity as record.analysis.quiz,
// whichever of quiz:ride-summary / activity:add arrives first.

const mockRecords = new Map();

jest.mock('../../../src/storage/idb.js', () => ({
    idb: {
        get: jest.fn(async (store, id) => {
            const r = mockRecords.get(id);
            return r ? JSON.parse(JSON.stringify(r)) : undefined;
        }),
        put: jest.fn(async (store, record) => { mockRecords.set(record.id, record); }),
        getAll: jest.fn(async () => Array.from(mockRecords.values())),
    },
}));
jest.mock('../../../src/models/models.js', () => ({ models: {} }));
jest.mock('../../../src/file.js', () => ({ fileHandler: {} }));

const analysis = require('../../../src/integrations/analysis/analysis.js');

function seed(id) {
    mockRecords.set(id, {id, summary: {id, name: 'Ride', timestamp: Date.now()}});
}

const db = {records: [], laps: [], ftp: 250, workout: null};
const quiz = {reviewed: 12, correct: 9, start: 1000, end: 2000};

describe('analysis: quiz ride summary', () => {
    beforeEach(() => mockRecords.clear());

    test('summary before save is attached on save', async () => {
        seed('a1');
        await analysis.onQuizSummary(quiz);
        await analysis.onActivitySaved({id: 'a1', name: 'Ride', timestamp: Date.now()}, db);
        expect(mockRecords.get('a1').analysis.quiz).toEqual(quiz);
    });

    test('summary after save patches the saved record', async () => {
        seed('a2');
        await analysis.onActivitySaved({id: 'a2', name: 'Ride', timestamp: Date.now()}, db);
        expect(mockRecords.get('a2').analysis.quiz).toBe(null);
        await analysis.onQuizSummary(quiz);
        expect(mockRecords.get('a2').analysis.quiz).toEqual(quiz);
        expect(mockRecords.get('a2').analysis.summary).toBeTruthy();
    });

    test('empty quiz rides are not stored', async () => {
        seed('a3');
        await analysis.onQuizSummary({reviewed: 0, correct: 0, start: 1, end: 2});
        await analysis.onActivitySaved({id: 'a3', name: 'Ride', timestamp: Date.now()}, db);
        expect(mockRecords.get('a3').analysis.quiz).toBe(null);
    });

    test('a stale summary is not attached to a later ride', async () => {
        seed('a4');
        await analysis.onQuizSummary(quiz, Date.now() - 10 * 60 * 1000);
        await analysis.onActivitySaved({id: 'a4', name: 'Ride', timestamp: Date.now()}, db);
        expect(mockRecords.get('a4').analysis.quiz).toBe(null);
    });
});
