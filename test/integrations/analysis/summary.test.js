import {
    summarizeActivity, normalizedPower, toStreams,
} from '../../../src/integrations/analysis/summary.js';

// Synthetic ride: 10 min @ 150W, 4 x (5 min @ 250W, 5 min @ 120W), 1Hz.
const FTP = 250;
const T0 = Date.UTC(2026, 9, 11, 17, 0, 0);

const workout = {
    meta: {name: 'Synthetic 4x5'},
    intervals: [
        {duration: 600, steps: [{duration: 600, power: 0.6}]},
        ...[0,1,2,3].flatMap(() => [
            {duration: 300, steps: [{duration: 300, power: 1.0, cadence: 95}]},
            {duration: 300, steps: [{duration: 300, power: 0.48}]},
        ]),
    ],
};

function buildRide({underperformLast = false, hrDrift = 0} = {}) {
    const records = [];
    const laps = [];
    let t = T0;
    workout.intervals.forEach((interval, i) => {
        const start = t;
        const target = interval.steps[0].power * FTP;
        // last hard interval only reaches 200W when underperforming
        const isLastHard = i === 7;
        const power = (underperformLast && isLastHard) ? 200 : target;
        for(let s = 0; s < interval.duration; s++) {
            const progress = records.length / 4200;
            records.push({
                timestamp: t,
                power,
                cadence: interval.steps[0].cadence ?? 85,
                heart_rate: Math.round(100 + power / 5 + hrDrift * progress),
                speed: 30,
            });
            // RR entries without timestamp must be ignored
            if(s % 60 === 0) records.push({time: [800]});
            t += 1000;
        }
        laps.push({start_time: start, timestamp: t});
    });
    return {id: 'ride-1', records, laps, workout, ftp: FTP};
}

describe('normalizedPower', () => {
    test('constant power equals that power', () => {
        expect(normalizedPower(new Array(600).fill(200))).toBeCloseTo(200, 6);
    });
    test('variable power is above average', () => {
        const p = [...new Array(300).fill(300), ...new Array(300).fill(100)];
        expect(normalizedPower(p)).toBeGreaterThan(200);
    });
    test('empty', () => {
        expect(normalizedPower([])).toBe(null);
    });
});

describe('summarizeActivity', () => {
    const summary = summarizeActivity(buildRide());

    test('duration and basic power', () => {
        expect(summary.durationSec).toBe(3000);
        expect(summary.elapsedSec).toBe(3000);
        // (600*150 + 4*300*250 + 4*300*120) / 3000
        expect(summary.power.avg).toBe(178);
        expect(summary.power.max).toBe(250);
        expect(summary.power.normalized).toBeGreaterThan(summary.power.avg);
        expect(summary.power.workKj).toBe(534);
    });

    test('IF and TSS use FTP', () => {
        const np = summary.power.normalized;
        expect(summary.power.intensityFactor).toBeCloseTo(np / FTP, 2);
        const tss = (3000 * np * (np / FTP)) / (FTP * 3600) * 100;
        expect(Math.abs(summary.power.tss - tss)).toBeLessThanOrEqual(1);
    });

    test('no IF/TSS/power zones without FTP', () => {
        const s = summarizeActivity({...buildRide(), ftp: undefined});
        expect(s.power.intensityFactor).toBe(null);
        expect(s.power.tss).toBe(null);
        expect(s.zones.power).toBe(null);
    });

    test('heart rate stats', () => {
        expect(summary.heartRate.max).toBe(150);
        expect(summary.heartRate.min).toBe(124);
        expect(summary.heartRate.decoupling).not.toBe(null);
    });

    test('cadence', () => {
        expect(summary.cadence.max).toBe(95);
        expect(summary.cadence.avg).toBe(89);
    });

    test('time in power zones', () => {
        const z = summary.zones.power;
        expect(z.length).toBe(7);
        const total = z.reduce((a, x) => a + x.seconds, 0);
        expect(total).toBe(3000);
        // 120W = 48% -> Z1, 150W = 60% -> Z2, 250W = 100% -> Z4
        expect(z[0].seconds).toBe(1200);
        expect(z[1].seconds).toBe(600);
        expect(z[3].seconds).toBe(1200);
    });

    test('heart rate zones only with maxHr or lthr', () => {
        expect(summary.zones.heartRate).toBe(null);
        const s = summarizeActivity(buildRide(), {maxHr: 190});
        expect(s.zones.heartRateBasis).toBe('maxHr');
        expect(s.zones.heartRate.reduce((a, x) => a + x.seconds, 0)).toBe(3000);
        const l = summarizeActivity(buildRide(), {lthr: 160});
        expect(l.zones.heartRateBasis).toBe('lthr');
    });

    test('interval compliance on target', () => {
        const c = summary.compliance;
        expect(c.method).toBe('laps');
        expect(c.plannedIntervals).toBe(9);
        expect(c.completedIntervals).toBe(9);
        expect(c.intervalsOnTarget).toBe(9);
        expect(c.score).toBe(100);
        expect(c.intervals[1].targetPower).toBe(250);
        expect(c.intervals[1].avgPower).toBe(250);
        expect(c.intervals[1].targetCadence).toBe(95);
        expect(c.intervals[1].status).toBe('on-target');
    });

    test('interval compliance detects underperformance', () => {
        const s = summarizeActivity(buildRide({underperformLast: true}));
        const last = s.compliance.intervals[7];
        expect(last.compliancePct).toBe(80);
        expect(last.status).toBe('under');
        expect(s.compliance.intervalsOnTarget).toBe(8);
        expect(s.compliance.score).toBeLessThan(100);
    });

    test('compliance falls back to planned durations without laps', () => {
        const s = summarizeActivity({...buildRide(), laps: []});
        expect(s.compliance.method).toBe('duration');
        expect(s.compliance.completedIntervals).toBe(9);
        expect(s.compliance.intervalsOnTarget).toBe(9);
    });

    test('HR drift / decoupling', () => {
        const s = summarizeActivity(buildRide({hrDrift: 20}));
        expect(s.heartRate.decoupling.hrDriftPct).toBeGreaterThan(0);
        expect(s.heartRate.decoupling.decouplingPct).toBeGreaterThan(0);
        expect(summary.heartRate.decoupling.decouplingPct).toBeLessThan(
            s.heartRate.decoupling.decouplingPct);
    });

    test('works from compact streams', () => {
        const ride = buildRide();
        const streams = toStreams(ride);
        expect(streams.power.length).toBe(3000);
        const s = summarizeActivity({streams, laps: ride.laps, workout, ftp: FTP});
        expect(s.power).toEqual(summary.power);
        expect(s.compliance.score).toBe(100);
    });

    test('empty activity does not throw', () => {
        const s = summarizeActivity({});
        expect(s.durationSec).toBe(0);
        expect(s.power.avg).toBe(null);
        expect(s.heartRate).toBe(null);
        expect(s.compliance).toBe(null);
    });

    test('is plain JSON', () => {
        expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    });
});
