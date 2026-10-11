import { HrController, HrControlStatus } from '../../src/integrations/hr-control/controller.js';

// Simple physiological model: HR follows power with a transport delay and a
// first order lag, plus optional slow cardiac drift and deterministic noise.
function Plant(args = {}) {
    const rest  = args.rest ?? 60;
    const gain  = args.gain ?? 0.35;   // bpm per W at steady state
    const tau   = args.tau ?? 45;      // s
    const delay = args.delay ?? 12;    // s
    const drift = args.drift ?? 0;     // bpm per minute
    const noise = args.noise ?? 0;     // +/- bpm
    let hr      = args.hr0 ?? rest;
    let t       = 0;
    let seed    = 42;
    const history = [];

    function rand() {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    }

    function step(power) {
        history.push(power);
        const delayed = history.length > delay ? history[history.length - 1 - delay] : history[0];
        const ss = rest + gain * delayed + drift * (t / 60);
        hr += (ss - hr) / tau;
        t += 1;
        return hr + (noise ? (rand() * 2 - 1) * noise : 0);
    }

    return { step, get hr() { return hr; } };
}

// runs the closed loop for `seconds`, returns per second trace
function simulate({ctrl, plant, seconds, t0 = 0, hrAvailable = () => true, pedaling = () => true}) {
    const trace = [];
    let power = ctrl.getState().power;
    for(let s = 0; s < seconds; s++) {
        const now = t0 + s * 1000;
        const hr  = plant.step(power);
        if(hrAvailable(s)) ctrl.addSample(Math.round(hr), now);
        const out = ctrl.tick(now, {pedaling: pedaling(s)});
        power = out.power;
        trace.push({s, now, hr, power, status: out.status});
    }
    return trace;
}

function maxStepChange(trace) {
    let max = 0;
    for(let i = 1; i < trace.length; i++) {
        max = Math.max(max, Math.abs(trace[i].power - trace[i-1].power));
    }
    return max;
}

describe('HrController convergence', () => {
    test('converges to target HR on a simulated rider', () => {
        const ctrl  = HrController({ftp: 250});
        const plant = Plant({rest: 60, gain: 0.35, hr0: 100});
        ctrl.start({now: 0, power: 150, target: 140});

        const trace = simulate({ctrl, plant, seconds: 20 * 60});
        const last5min = trace.slice(-300);
        const avgHr = last5min.reduce((a, x) => a + x.hr, 0) / last5min.length;

        // steady state power needed: (140 - 60) / 0.35 = 228.6 W
        expect(Math.abs(avgHr - 140)).toBeLessThan(2);
        expect(Math.abs(trace[trace.length-1].power - 229)).toBeLessThan(10);
        // no large overshoot
        const peak = Math.max(...trace.map(x => x.hr));
        expect(peak).toBeLessThan(140 + 6);
        // settles within 3 bpm in under 12 minutes and stays there
        const settled = trace.slice(12 * 60).every(x => Math.abs(x.hr - 140) < 3);
        expect(settled).toBe(true);
        expect(trace[trace.length-1].status).toBe(HrControlStatus.active);
    });

    test('tracks a lower target from a higher HR, with noise and cardiac drift', () => {
        const ctrl  = HrController({ftp: 280});
        const plant = Plant({rest: 55, gain: 0.3, hr0: 150, drift: 0.3, noise: 2});
        ctrl.start({now: 0, power: 280, target: 130});

        const trace = simulate({ctrl, plant, seconds: 25 * 60});
        const last5min = trace.slice(-300);
        const avgHr = last5min.reduce((a, x) => a + x.hr, 0) / last5min.length;
        expect(Math.abs(avgHr - 130)).toBeLessThan(2.5);
    });

    test('follows a target change', () => {
        const ctrl  = HrController({ftp: 250});
        const plant = Plant({rest: 60, gain: 0.35, hr0: 100});
        ctrl.start({now: 0, power: 150, target: 130});
        let trace = simulate({ctrl, plant, seconds: 15 * 60});
        ctrl.setTarget(145);
        trace = simulate({ctrl, plant, seconds: 15 * 60, t0: 15 * 60 * 1000});
        const avgHr = trace.slice(-300).reduce((a, x) => a + x.hr, 0) / 300;
        expect(Math.abs(avgHr - 145)).toBeLessThan(2);
    });
});

describe('HrController step limiting and timing', () => {
    test('does not react before 30s of HR data', () => {
        const ctrl = HrController({ftp: 200});
        ctrl.start({now: 0, power: 120, target: 160});
        for(let s = 0; s < 29; s++) {
            ctrl.addSample(100, s * 1000);
            const out = ctrl.tick(s * 1000);
            expect(out.power).toBe(120);
            expect(out.status).toBe(HrControlStatus.warmup);
        }
    });

    test('changes power at most maxStep per interval', () => {
        const ctrl = HrController({ftp: 300, maxStep: 10, intervalMs: 5000});
        ctrl.start({now: 0, power: 130, target: 170});
        const trace = [];
        for(let s = 0; s < 300; s++) {
            ctrl.addSample(100, s * 1000); // far below target -> wants max increase
            trace.push(ctrl.tick(s * 1000));
        }
        expect(maxStepChange(trace)).toBeLessThanOrEqual(10);
        // adjustments happen no more often than every 5 s
        const changes = trace.map((x, i) => ({...x, i})).filter((x, i) => i > 0 && x.power !== trace[i-1].power);
        for(let i = 1; i < changes.length; i++) {
            expect(changes[i].i - changes[i-1].i).toBeGreaterThanOrEqual(5);
        }
        expect(changes.length).toBeGreaterThan(0);
    });

    test('respects a custom max step', () => {
        const ctrl = HrController({ftp: 300, maxStep: 15});
        ctrl.start({now: 0, power: 100, target: 60});
        const trace = [];
        for(let s = 0; s < 200; s++) {
            ctrl.addSample(180, s * 1000);
            trace.push(ctrl.tick(s * 1000));
        }
        expect(maxStepChange(trace)).toBeLessThanOrEqual(15);
    });

    test('integrator does not wind up while saturated', () => {
        const ctrl = HrController({ftp: 200}); // max 220 W
        ctrl.start({now: 0, power: 200, target: 180});
        let s = 0;
        // HR stuck low for 10 minutes: power pinned at max
        for(; s < 600; s++) {
            ctrl.addSample(120, s * 1000);
            ctrl.tick(s * 1000);
        }
        expect(ctrl.getState().power).toBe(220);
        // HR now above target -> power must start dropping on the next adjustment
        let out;
        for(let k = 0; k < 6; k++, s++) {
            ctrl.addSample(185, s * 1000);
            out = ctrl.tick(s * 1000);
        }
        // smoothing window still mixes old samples, give it a bit more
        for(let k = 0; k < 15; k++, s++) {
            ctrl.addSample(185, s * 1000);
            out = ctrl.tick(s * 1000);
        }
        expect(out.power).toBeLessThan(220);
    });
});

describe('HrController bounds', () => {
    test('power stays within 40% FTP and 110% FTP by default', () => {
        const ctrl = HrController({ftp: 250});
        expect(ctrl.bounds()).toEqual({min: 100, max: 275, safe: 100});

        ctrl.start({now: 0, power: 180, target: 200});
        let s = 0;
        for(; s < 900; s++) {
            ctrl.addSample(100, s * 1000);
            expect(ctrl.tick(s * 1000).power).toBeLessThanOrEqual(275);
        }
        expect(ctrl.getState().power).toBe(275);

        ctrl.setTarget(90);
        for(; s < 2400; s++) {
            ctrl.addSample(170, s * 1000);
            expect(ctrl.tick(s * 1000).power).toBeGreaterThanOrEqual(100);
        }
        expect(ctrl.getState().power).toBe(100);
    });

    test('start power is clamped into bounds', () => {
        const ctrl = HrController({ftp: 200});
        expect(ctrl.start({now: 0, power: 500, target: 140}).power).toBe(220);
        expect(ctrl.start({now: 0, power: 10, target: 140}).power).toBe(80);
        expect(ctrl.start({now: 0, power: 0, target: 140}).power).toBe(80);
    });

    test('max power can be configured', () => {
        const ctrl = HrController({ftp: 200, maxPowerPct: 0.9});
        expect(ctrl.bounds().max).toBe(180);
        ctrl.configure({maxPower: 150});
        expect(ctrl.bounds().max).toBe(150);
    });

    test('lowering FTP while running clamps power', () => {
        const ctrl = HrController({ftp: 300});
        ctrl.start({now: 0, power: 300, target: 140});
        ctrl.configure({ftp: 200});
        ctrl.addSample(140, 0);
        expect(ctrl.tick(0).power).toBe(220);
    });
});

describe('HrController signal loss', () => {
    function runToActive(ctrl) {
        ctrl.start({now: 0, power: 180, target: 150});
        let s = 0;
        for(; s < 60; s++) {
            ctrl.addSample(140, s * 1000);
            ctrl.tick(s * 1000);
        }
        return s;
    }

    test('freezes power when HR is stale, drops to safe power after 30s', () => {
        const ctrl = HrController({ftp: 250});
        let s = runToActive(ctrl);
        const lastSample = (s - 1) * 1000;
        let frozen = null;

        // no samples from here
        for(; s < 100; s++) {
            const now = s * 1000;
            const out = ctrl.tick(now);
            const lostFor = now - lastSample;
            if(lostFor <= 5000) {
                expect(out.status).toBe(HrControlStatus.active);
            } else if(lostFor < 30000) {
                expect(out.status).toBe(HrControlStatus.signalLost);
                frozen = frozen ?? out.power;
                expect(frozen).toBeGreaterThan(100);
                expect(out.power).toBe(frozen);
            } else {
                expect(out.status).toBe(HrControlStatus.signalLostSafe);
                expect(out.power).toBe(100);
            }
        }
    });

    test('safe drop never increases power', () => {
        const ctrl = HrController({ftp: 250, safePowerPct: 0.6});
        ctrl.start({now: 0, power: 110, target: 150});
        const out = ctrl.tick(40000); // never received HR
        expect(out.status).toBe(HrControlStatus.signalLostSafe);
        expect(out.power).toBe(110);
    });

    test('zero / invalid HR readings count as no signal', () => {
        const ctrl = HrController({ftp: 250});
        let s = runToActive(ctrl);
        for(let k = 0; k < 10; k++, s++) {
            ctrl.addSample(0, s * 1000);
            ctrl.tick(s * 1000);
        }
        expect(ctrl.tick(s * 1000).status).toBe(HrControlStatus.signalLost);
    });

    test('requires a new warmup after the signal returns', () => {
        const ctrl = HrController({ftp: 250});
        let s = runToActive(ctrl);
        s += 40; // 40 s gap
        expect(ctrl.tick(s * 1000).status).toBe(HrControlStatus.signalLostSafe);
        const safe = ctrl.getState().power;
        for(let k = 0; k < 29; k++, s++) {
            ctrl.addSample(110, s * 1000);
            const out = ctrl.tick(s * 1000);
            expect(out.status).toBe(HrControlStatus.warmup);
            expect(out.power).toBe(safe);
        }
        for(let k = 0; k < 10; k++, s++) {
            ctrl.addSample(110, s * 1000);
            ctrl.tick(s * 1000);
        }
        expect(ctrl.getState().status).toBe(HrControlStatus.active);
        expect(ctrl.getState().power).toBeGreaterThan(safe);
    });
});

describe('HrController max HR ceiling and pausing', () => {
    test('forces power down above max HR, even during warmup', () => {
        const ctrl = HrController({ftp: 250, maxHr: 170, ceilingStep: 20});
        ctrl.start({now: 0, power: 250, target: 175});
        ctrl.addSample(172, 0);
        let out = ctrl.tick(0);
        expect(out.status).toBe(HrControlStatus.ceiling);
        expect(out.power).toBe(230);
        // not again before the next interval
        ctrl.addSample(172, 1000);
        expect(ctrl.tick(1000).power).toBe(230);
        ctrl.addSample(172, 5000);
        expect(ctrl.tick(5000).power).toBe(210);
        // never below min
        for(let s = 6; s < 120; s++) {
            ctrl.addSample(175, s * 1000);
            out = ctrl.tick(s * 1000);
        }
        expect(out.power).toBe(100);
    });

    test('holds power while not pedaling', () => {
        const ctrl = HrController({ftp: 250});
        ctrl.start({now: 0, power: 150, target: 170});
        let out;
        for(let s = 0; s < 120; s++) {
            ctrl.addSample(90, s * 1000);
            out = ctrl.tick(s * 1000, {pedaling: false});
        }
        expect(out.status).toBe(HrControlStatus.paused);
        expect(out.power).toBe(150);
    });

    test('idle when not started', () => {
        const ctrl = HrController();
        expect(ctrl.tick(0).status).toBe(HrControlStatus.idle);
        ctrl.start({now: 0, power: 150, target: 140});
        ctrl.stop();
        expect(ctrl.tick(1000).status).toBe(HrControlStatus.idle);
    });
});
