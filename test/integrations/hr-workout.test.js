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
