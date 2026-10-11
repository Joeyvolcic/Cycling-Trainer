import {
    powerFraction, intervalIntensity, classifyIntensity, planSegments, playlistFor,
    switchDecision, shouldAutoPause,
} from '../../../src/integrations/media/intensity.js';

const iv = (duration, power) => ({duration, steps: [{duration, power}]});

describe('intensity classification', () => {
    test('power as fraction or absolute watts', () => {
        expect(powerFraction(0.75, 250)).toBe(0.75);
        expect(powerFraction(250, 250)).toBe(1);
        expect(powerFraction(250, null)).toBeNull();
        expect(powerFraction(0, 250)).toBeNull();
        expect(powerFraction(undefined, 250)).toBeNull();
    });

    test('time weighted interval intensity', () => {
        const ramp = {duration: 300, steps: [{duration: 100, power: 0.5}, {duration: 200, power: 0.8}]};
        expect(intervalIntensity(ramp, 200)).toBeCloseTo(0.7);
        expect(intervalIntensity({duration: 60, steps: [{duration: 60, slope: 3}]}, 200)).toBeNull();
    });

    test('zone buckets', () => {
        expect(classifyIntensity(0.5)).toBe('recovery');
        expect(classifyIntensity(0.65)).toBe('endurance');
        expect(classifyIntensity(0.88)).toBe('threshold');
        expect(classifyIntensity(1.0)).toBe('threshold');
        expect(classifyIntensity(1.2)).toBe('vo2');
        expect(classifyIntensity(null)).toBeNull();
    });
});

describe('planSegments', () => {
    test('warm-up, main set, cool-down', () => {
        const plan = planSegments([
            iv(300, 0.5), iv(300, 0.65),     // warm-up
            iv(600, 0.95), iv(300, 0.5),     // threshold, long recovery
            iv(600, 0.95),
            iv(600, 0.7),                    // endurance block between hard efforts
            iv(180, 1.2),
            iv(300, 0.5), iv(300, 0.45),     // cool-down
        ], 250);
        expect(plan).toEqual([
            'warmup', 'warmup',
            'threshold', 'recovery',
            'threshold',
            'endurance',
            'vo2',
            'recovery', 'recovery',
        ]);
    });

    test('short rests between hard efforts keep the hard playlist', () => {
        const plan = planSegments([
            iv(600, 0.6),
            iv(30, 1.3), iv(30, 0.4), iv(30, 1.3), iv(30, 0.4), iv(30, 1.3),
            iv(600, 0.5),
        ], 250);
        expect(plan).toEqual(['warmup', 'vo2', 'vo2', 'vo2', 'vo2', 'vo2', 'recovery']);
    });

    test('long easy start is only warm-up for the first 20 minutes', () => {
        const plan = planSegments([iv(900, 0.6), iv(900, 0.6), iv(600, 1.0)], 250);
        expect(plan).toEqual(['warmup', 'endurance', 'threshold']);
    });

    test('endurance ride without hard efforts stays endurance', () => {
        expect(planSegments([iv(3600, 0.65)], 250)).toEqual(['endurance']);
    });

    test('slope-only intervals inherit the previous type', () => {
        const plan = planSegments([iv(600, 0.6), {duration: 300, steps: [{duration: 300, slope: 4}]}], 250);
        expect(plan).toEqual(['endurance', 'endurance']);
    });

    test('absolute watt targets use ftp', () => {
        expect(planSegments([iv(600, 150), iv(300, 300), iv(300, 120)], 250)).toEqual(['warmup', 'vo2', 'recovery']);
    });

    test('empty workout', () => {
        expect(planSegments([], 250)).toEqual([]);
        expect(planSegments(undefined, 250)).toEqual([]);
    });
});

describe('segment -> playlist mapping', () => {
    const mapping = {
        warmup:    {uri: 'spotify:playlist:warm', name: 'Warm'},
        threshold: {uri: 'spotify:playlist:thr', name: 'Thr'},
        fallback:  {uri: 'spotify:playlist:any', name: 'Any'},
    };

    test('direct mapping and fallback', () => {
        expect(playlistFor(mapping, 'warmup').uri).toBe('spotify:playlist:warm');
        expect(playlistFor(mapping, 'vo2').uri).toBe('spotify:playlist:any');
        expect(playlistFor({}, 'vo2')).toBeNull();
        expect(playlistFor(mapping, null)).toBeNull();
    });

    test('switches when the target playlist differs', () => {
        expect(switchDecision({type: 'threshold', mapping, currentContextUri: 'spotify:playlist:warm'}))
            .toEqual({action: 'switch', uri: 'spotify:playlist:thr', name: 'Thr', type: 'threshold'});
    });

    test('does not restart the playlist already playing', () => {
        expect(switchDecision({type: 'threshold', mapping, currentContextUri: 'spotify:playlist:thr'}).reason).toBe('already-playing');
    });

    test('never interrupts podcasts/audiobooks', () => {
        expect(switchDecision({type: 'threshold', mapping, spokenPlaying: true}).reason).toBe('spoken-content');
    });

    test('disabled / unmapped', () => {
        expect(switchDecision({enabled: false, type: 'warmup', mapping}).reason).toBe('disabled');
        expect(switchDecision({type: 'vo2', mapping: {}}).reason).toBe('no-playlist');
        expect(switchDecision({type: null, mapping}).reason).toBe('no-segment-type');
    });

    test('auto pause only for spoken content that is playing', () => {
        expect(shouldAutoPause({enabled: true, isPlaying: true, spoken: true})).toBe(true);
        expect(shouldAutoPause({enabled: true, isPlaying: true, spoken: false})).toBe(false);
        expect(shouldAutoPause({enabled: false, isPlaying: true, spoken: true})).toBe(false);
        expect(shouldAutoPause({enabled: true, isPlaying: false, spoken: true})).toBe(false);
    });
});
