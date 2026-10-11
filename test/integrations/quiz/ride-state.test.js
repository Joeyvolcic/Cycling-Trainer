import {
    Zone, SessionMode, NewCardPolicy, classify, sessionAllows, newCardsAllowed, RideState,
} from '../../../src/integrations/quiz/ride-state.js';
import { ratingFromTranscript } from '../../../src/integrations/quiz/speech.js';

describe('classify', () => {
    test('zones by % FTP', () => {
        expect(classify(100, 250)).toBe(Zone.recovery);
        expect(classify(170, 250)).toBe(Zone.endurance);
        expect(classify(215, 250)).toBe(Zone.tempo);
        expect(classify(260, 250)).toBe(Zone.work);
        expect(classify(0, 250)).toBe(Zone.unknown);
        expect(classify(200, 0)).toBe(Zone.unknown);
    });
});

describe('gating', () => {
    test('session modes', () => {
        expect(sessionAllows(SessionMode.always, Zone.work)).toBe(true);
        expect(sessionAllows(SessionMode.recovery, Zone.work)).toBe(false);
        expect(sessionAllows(SessionMode.recovery, Zone.recovery)).toBe(true);
        expect(sessionAllows(SessionMode.work, Zone.recovery)).toBe(false);
        expect(sessionAllows(SessionMode.work, Zone.work)).toBe(true);
        expect(sessionAllows(SessionMode.recovery, Zone.idle)).toBe(true);
    });
    test('new card policies', () => {
        expect(newCardsAllowed(NewCardPolicy.never, Zone.tempo)).toBe(false);
        expect(newCardsAllowed(NewCardPolicy.never, Zone.idle)).toBe(true);
        expect(newCardsAllowed(NewCardPolicy.suggested, Zone.endurance)).toBe(false);
        expect(newCardsAllowed(NewCardPolicy.suggested, Zone.tempo)).toBe(true);
        expect(newCardsAllowed(NewCardPolicy.suggested, Zone.recovery, true)).toBe(true);
        expect(newCardsAllowed(NewCardPolicy.anytime, Zone.work)).toBe(true);
    });
});

describe('RideState', () => {
    test('tracks zone from target, falls back to power, and the after-interval window', () => {
        let t = 0;
        const rs = new RideState({ now: () => t, afterIntervalMs: 60000 });
        expect(rs.update({ ftp: 200 })).toBe(Zone.idle);
        rs.update({ running: true, powerTarget: 0, power: 130 });
        expect(rs.zone).toBe(Zone.endurance);
        rs.update({ powerTarget: 240 });
        expect(rs.zone).toBe(Zone.work);
        t = 1000;
        rs.update({ powerTarget: 100 });
        expect(rs.zone).toBe(Zone.recovery);
        expect(rs.gate({ newPolicy: NewCardPolicy.suggested })).toMatchObject({ afterInterval: true, allowNew: true, show: true });
        t = 1000 + 61000;
        expect(rs.gate({ newPolicy: NewCardPolicy.suggested }).allowNew).toBe(false);
        expect(rs.gate({ mode: SessionMode.work }).show).toBe(false);
        rs.update({ running: false });
        expect(rs.zone).toBe(Zone.idle);
    });
});

describe('voice grading', () => {
    test('transcript -> rating', () => {
        expect(ratingFromTranscript('Again')).toBe(1);
        expect(ratingFromTranscript('that was hard')).toBe(2);
        expect(ratingFromTranscript('good')).toBe(3);
        expect(ratingFromTranscript('Easy')).toBe(4);
        expect(ratingFromTranscript('skip')).toBe('skip');
        expect(ratingFromTranscript('say again')).toBe('repeat');
        expect(ratingFromTranscript('banana')).toBeNull();
    });
});
