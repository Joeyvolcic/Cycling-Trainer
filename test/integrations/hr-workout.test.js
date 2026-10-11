/**
 * @jest-environment jsdom
 */

import { zwo } from '../../src/workouts/zwo.js';
import { xf } from '../../src/functions.js';
import { HrControlRuntime } from '../../src/integrations/hr-control/hr-control.js';
import { HrControlStatus } from '../../src/integrations/hr-control/controller.js';

const removeWhiteSpace = (str) => str.replace(/\s/g,'');

function workoutFile(body) {
    return `
    <workout_file>
        <author>Flux</author>
        <name>HR Test</name>
        <category>Endurance</category>
        <description>HR test</description>
        <sporttype>bike</sporttype>
        <workout>
            ${body}
        </workout>
    </workout_file>`;
}

describe('zwo heart rate targets', () => {
    test('SteadyState with HeartRate only', () => {
        const res = zwo.readToInterval(workoutFile(`
            <SteadyState Duration="600" HeartRate="135"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 600, steps: [{duration: 600, heartRate: 135}]},
        ]);
    });

    test('SteadyState with HeartRate, seed Power and Cadence', () => {
        const res = zwo.readToInterval(workoutFile(`
            <SteadyState Duration="300" Power="0.6" HeartRate="140" Cadence="90"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 300, steps: [{duration: 300, power: 0.6, heartRate: 140, cadence: 90}]},
        ]);
    });

    test('IntervalsT with On/Off HeartRate', () => {
        const res = zwo.readToInterval(workoutFile(`
            <IntervalsT Repeat="2" OnDuration="300" OffDuration="120" OnHeartRate="155" OffHeartRate="120"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 300, steps: [{duration: 300, heartRate: 155}]},
            {duration: 120, steps: [{duration: 120, heartRate: 120}]},
            {duration: 300, steps: [{duration: 300, heartRate: 155}]},
            {duration: 120, steps: [{duration: 120, heartRate: 120}]},
        ]);
    });

    test('power steps are unchanged', () => {
        const res = zwo.readToInterval(workoutFile(`
            <SteadyState Duration="60" Power="0.5"/>
            <SteadyState Duration="60"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 60, steps: [{duration: 60, power: 0.5}]},
            {duration: 60, steps: [{duration: 60, power: 0, slope: 0}]},
        ]);
    });

    test('writes HeartRate back to zwo', () => {
        const res = zwo.fromInterval({
            meta: {author: 'Flux', name: 'HR', category: 'Endurance', subcategory: '',
                   sportType: 'bike', description: 'HR'},
            intervals: [{duration: 600, steps: [{duration: 600, heartRate: 135}]}],
        });
        expect(res.body).toEqual([{element: 'SteadyState', Duration: 600, HeartRate: 135}]);
        expect(removeWhiteSpace(zwo.body.write(res.body)))
            .toBe(removeWhiteSpace('<workout><SteadyState Duration="600" HeartRate="135" /></workout>'));
    });

    test('HeartRate <= 2 is kept as a fraction of LTHR', () => {
        const res = zwo.readToInterval(workoutFile(`
            <SteadyState Duration="600" HeartRate="0.85"/>
            <IntervalsT Repeat="1" OnDuration="60" OffDuration="60" OnHeartRate="0.95" OffHeartRate="0.7"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 600, steps: [{duration: 600, heartRate: 0.85}]},
            {duration: 60, steps: [{duration: 60, heartRate: 0.95}]},
            {duration: 60, steps: [{duration: 60, heartRate: 0.7}]},
        ]);
    });

    test('Warmup with a bpm heart rate ramp (no power)', () => {
        const res = zwo.readToInterval(workoutFile(`
            <Warmup Duration="40" HeartRateLow="100" HeartRateHigh="130"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 40, steps: [
                {duration: 10, heartRate: 100},
                {duration: 10, heartRate: 110},
                {duration: 10, heartRate: 120},
                {duration: 10, heartRate: 130},
            ]},
        ]);
    });

    test('Warmup with power and an LTHR-relative heart rate ramp', () => {
        const res = zwo.readToInterval(workoutFile(`
            <Warmup Duration="30" PowerLow="0.5" PowerHigh="0.7" HeartRateLow="0.7" HeartRateHigh="0.8"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 30, steps: [
                {duration: 10, power: 0.5, heartRate: 0.7},
                {duration: 10, power: 0.6, heartRate: 0.75},
                {duration: 10, power: 0.7, heartRate: 0.8},
            ]},
        ]);
    });

    test('Cooldown heart rate ramp goes from HeartRateLow (start) to HeartRateHigh (end)', () => {
        const res = zwo.readToInterval(workoutFile(`
            <Cooldown Duration="30" HeartRateLow="140" HeartRateHigh="110"/>
        `));
        expect(res.intervals).toEqual([
            {duration: 30, steps: [
                {duration: 10, heartRate: 140},
                {duration: 10, heartRate: 125},
                {duration: 10, heartRate: 110},
            ]},
        ]);
    });

    test('flat HeartRate on a Warmup and mixed units are handled', () => {
        const flat = zwo.readToInterval(workoutFile(`
            <Warmup Duration="20" PowerLow="0.4" PowerHigh="0.6" HeartRate="120"/>
        `));
        expect(flat.intervals[0].steps.map(s => s.heartRate)).toEqual([120, 120]);

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const mixed = zwo.readToInterval(workoutFile(`
            <Warmup Duration="20" PowerLow="0.4" PowerHigh="0.6" HeartRateLow="0.7" HeartRateHigh="140"/>
        `));
        expect(mixed.intervals[0].steps.every(s => s.heartRate === undefined)).toBe(true);
        warn.mockRestore();
    });

    test('writes heart rate ramps back to zwo', () => {
        const meta = {author: 'Flux', name: 'HR', category: 'Endurance', subcategory: '',
                      sportType: 'bike', description: 'HR'};
        const warmup = zwo.readToInterval(workoutFile(`
            <Warmup Duration="30" PowerLow="0.5" PowerHigh="0.7" HeartRateLow="0.7" HeartRateHigh="0.8"/>
        `));
        const res = zwo.fromInterval({meta, intervals: warmup.intervals});
        expect(res.body).toEqual([{element: 'Warmup', Duration: 30, PowerLow: 0.5, PowerHigh: 0.7,
                                   HeartRateLow: 0.7, HeartRateHigh: 0.8}]);
    });
});

describe('heart rate targets relative to LTHR', () => {
    const { toBpm, toLthrPct, formatHeartRate, isRelativeHeartRate, athlete } =
          require('../../src/integrations/hr-control/targets.js');

    afterEach(() => window.localStorage.clear());

    test('values <= 2 are a fraction of LTHR, > 2 are bpm', () => {
        expect(isRelativeHeartRate(0.85)).toBe(true);
        expect(isRelativeHeartRate(2)).toBe(true);
        expect(isRelativeHeartRate(135)).toBe(false);
        expect(toBpm(0.85, {lthr: 170})).toBe(145);
        expect(toBpm(135, {lthr: 170})).toBe(135);
        expect(toBpm(135.4, {lthr: null})).toBe(135);
    });

    test('a relative target without LTHR cannot be resolved', () => {
        expect(toBpm(0.85, {lthr: null})).toBe(null);
        expect(toBpm(0, {lthr: 170})).toBe(null);
        expect(toBpm(undefined, {lthr: 170})).toBe(null);
    });

    test('LTHR comes from the analysis settings', () => {
        expect(athlete().lthr).toBe(null);
        window.localStorage.setItem('analysis:lthr', '160');
        window.localStorage.setItem('analysis:max-hr', '190');
        expect(athlete()).toEqual({lthr: 160, maxHr: 190});
        expect(toBpm(0.9)).toBe(144);
        expect(toLthrPct(144)).toBe(90);
    });

    test('labels', () => {
        expect(formatHeartRate(135, {lthr: 170})).toBe('135bpm');
        expect(formatHeartRate(0.85, {lthr: 170})).toBe('85% LTHR (145bpm)');
        expect(formatHeartRate(0.85, {lthr: null})).toBe('85% LTHR');
    });
});

describe('HrControlRuntime', () => {
    let runtime;
    let powerTargets;
    let statuses;
    const onPower = v => { powerTargets.push(v); xf.dispatch('db:powerTarget', {powerTarget: v}); };
    const onStatus = s => statuses.push(s);

    beforeAll(() => {
        jest.useFakeTimers('modern');
        jest.setSystemTime(0);
        window.localStorage.clear();
        runtime = HrControlRuntime();
        window.addEventListener('ui:power-target-set', e => onPower(e.detail.data));
        window.addEventListener('hr-control:status', e => onStatus(e.detail.data));
        window.addEventListener('ui:heart-rate-target-set', e => {
            xf.dispatch('db:heartRateTarget', {heartRateTarget: e.detail.data});
        });
        xf.dispatch('db:ftp', {ftp: 250});
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    beforeEach(() => {
        powerTargets = [];
        statuses = [];
    });

    function ride(seconds, hr) {
        for(let s = 0; s < seconds; s++) {
            xf.dispatch('db:heartRate', {heartRate: hr});
            xf.dispatch('db:power', {power: 150});
            jest.advanceTimersByTime(1000);
        }
    }

    test('entering heart rate mode starts the controller from the current power target', () => {
        xf.dispatch('db:powerTarget', {powerTarget: 160});
        xf.dispatch('db:mode', {mode: 'heartRate'});
        expect(runtime.isActive()).toBe(true);
        // a target is picked from the remembered default
        expect(runtime.controller.getTarget()).toBe(130);
        jest.advanceTimersByTime(0);
        expect(powerTargets[0]).toBe(160);
        expect(statuses[0].status).toBe(HrControlStatus.warmup);
    });

    test('drives the power target up when HR is below target', () => {
        xf.dispatch('db:heartRateTarget', {heartRateTarget: 150});
        ride(120, 110);
        const last = powerTargets[powerTargets.length - 1];
        expect(last).toBeGreaterThan(160);
        expect(runtime.getStatus().status).toBe(HrControlStatus.active);
        // never more than 10 W per change
        for(let i = 1; i < powerTargets.length; i++) {
            expect(Math.abs(powerTargets[i] - powerTargets[i-1])).toBeLessThanOrEqual(10);
        }
    });

    test('warns and freezes when HR stops', () => {
        let frozen = null;
        for(let s = 0; s < 20; s++) {
            xf.dispatch('db:heartRate', {heartRate: 0}); // disconnected sensor
            xf.dispatch('db:power', {power: 150});
            jest.advanceTimersByTime(1000);
            if(runtime.getStatus().status === HrControlStatus.signalLost) {
                frozen = frozen ?? runtime.getStatus().power;
                expect(runtime.getStatus().power).toBe(frozen);
                expect(runtime.getStatus().message).toMatch(/signal lost/);
            }
        }
        expect(frozen).not.toBe(null);
        expect(runtime.getStatus().status).toBe(HrControlStatus.signalLost);
        jest.advanceTimersByTime(30000);
        expect(runtime.getStatus().status).toBe(HrControlStatus.signalLostSafe);
        expect(runtime.getStatus().power).toBe(100);
    });

    test('leaving heart rate mode stops the controller', () => {
        xf.dispatch('db:mode', {mode: 'erg'});
        expect(runtime.isActive()).toBe(false);
        const count = powerTargets.length;
        jest.advanceTimersByTime(10000);
        expect(powerTargets.length).toBe(count);
        expect(statuses[statuses.length - 1].status).toBe(HrControlStatus.idle);
    });
});
