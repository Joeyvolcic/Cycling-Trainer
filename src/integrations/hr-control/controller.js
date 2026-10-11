//
// Heart-rate control: closed loop PI controller on top of ERG.
//
// Pure module: no DOM, no xf, no timers. Time is always passed in (ms), so the
// controller can be driven by setInterval in the app and by a simulated clock
// in tests.
//
// Usage:
//   const ctrl = HrController({ftp: 250});
//   ctrl.start({now, power: 150, target: 140});
//   ctrl.addSample(hr, now);            // on every heart rate reading
//   const out = ctrl.tick(now);         // ~every second
//   // out.power -> ERG target to send, out.status -> HrControlStatus
//
// Control law (positional PI with back-calculation anti-windup):
//   e   = target - smoothedHr
//   I  += ki * dt * e
//   u   = base + kp * e + I
//   out = clamp(minPower, maxPower, clamp(power - maxStep, power + maxStep, u))
//   I   = out - base - kp * e     (integrator tracks what was actually applied)
//
// Heart rate reacts to power with a delay and a long time constant, so:
//   - HR is smoothed over `smoothingMs` (moving average),
//   - no adjustment is made until `warmupMs` of continuous HR data is available,
//   - power only changes every `intervalMs` and by at most `maxStep` watts.
//

const HrControlStatus = Object.freeze({
    idle:           'idle',             // controller not running
    warmup:         'warmup',           // collecting HR data, power held
    active:         'active',           // closed loop control
    paused:         'paused',           // rider not pedaling, power held
    signalLost:     'signal-lost',      // HR stale, power frozen
    signalLostSafe: 'signal-lost-safe', // HR stale for long, power dropped to safe value
    ceiling:        'ceiling',          // HR above max HR ceiling, power forced down
});

const defaults = Object.freeze({
    ftp:          200,
    minPowerPct:  0.40,   // of FTP
    maxPowerPct:  1.10,   // of FTP
    maxPower:     undefined, // absolute W, overrides maxPowerPct when set
    safePowerPct: 0.40,   // of FTP, used after prolonged HR signal loss

    intervalMs:   5000,   // how often power is adjusted
    smoothingMs:  12000,  // HR moving average window
    warmupMs:     30000,  // continuous HR data needed before reacting
    staleMs:      5000,   // HR older than this -> signal lost, freeze power
    dropAfterMs:  30000,  // HR older than this -> drop to safe power

    kp:           1.5,    // W per bpm
    ki:           0.03,   // W per bpm per second
    maxStep:      10,     // W per adjustment
    deadband:     1,      // bpm, error inside the band is treated as 0

    maxHr:        0,      // bpm, 0 disables the ceiling
    ceilingStep:  20,     // W removed per interval while above maxHr

    minValidHr:   30,
    maxValidHr:   250,
});

function clamp(min, max, value) {
    return Math.min(max, Math.max(min, value));
}

function isValidHr(hr, config) {
    return Number.isFinite(hr) && hr >= config.minValidHr && hr <= config.maxValidHr;
}

function HrController(options = {}) {
    let config = Object.assign({}, defaults, options);

    let running        = false;
    let target         = 0;
    let power          = 0;     // currently commanded power (W, integer)
    let base           = 0;     // power when control (re)started, for bumpless transfer
    let integral       = 0;
    let samples        = [];    // [{t, hr}] inside the smoothing window
    let dataStart      = null;  // start of the current run of continuous HR data
    let lastSampleAt   = null;
    let startedAt      = null;
    let lastControlAt  = null;
    let lastCeilingAt  = null;
    let lastStatus     = HrControlStatus.idle;
    let lastError      = null;

    function configure(patch = {}) {
        const cleaned = {};
        Object.keys(patch).forEach(key => {
            if(patch[key] !== undefined) cleaned[key] = patch[key];
        });
        config = Object.assign({}, config, cleaned);
        if(running) power = Math.round(clamp(bounds().min, bounds().max, power));
        return getConfig();
    }

    function getConfig() {
        return Object.assign({}, config);
    }

    function bounds() {
        const ftp = config.ftp > 0 ? config.ftp : defaults.ftp;
        const min = Math.round(config.minPowerPct * ftp);
        let max   = Number.isFinite(config.maxPower) && config.maxPower > 0 ?
                    config.maxPower :
                    Math.round(config.maxPowerPct * ftp);
        max = Math.max(min, max);
        const safe = clamp(min, max, Math.round(config.safePowerPct * ftp));
        return {min, max, safe};
    }

    function start(args = {}) {
        const now = args.now ?? 0;
        const b   = bounds();

        running       = true;
        startedAt     = now;
        target        = Number.isFinite(args.target) ? args.target : target;
        power         = Math.round(clamp(b.min, b.max, Number.isFinite(args.power) && args.power > 0 ?
                                                       args.power : b.safe));
        lastControlAt = now;
        lastCeilingAt = null;
        resetLoop();
        // keep samples already collected, HR may have been streaming before
        // the mode was switched on
        return output(now, HrControlStatus.warmup, true);
    }

    function stop() {
        running    = false;
        lastStatus = HrControlStatus.idle;
    }

    function resetLoop() {
        base      = power;
        integral  = 0;
        lastError = null;
    }

    function isRunning() {
        return running;
    }

    function setTarget(bpm) {
        if(Number.isFinite(bpm) && bpm > 0) target = bpm;
        return target;
    }

    function getTarget() {
        return target;
    }

    function addSample(hr, now) {
        if(!isValidHr(hr, config)) return false;

        // a gap longer than staleMs breaks continuity -> restart warmup
        if(lastSampleAt === null || (now - lastSampleAt) > config.staleMs) {
            dataStart = now;
            samples   = [];
        }

        lastSampleAt = now;
        samples.push({t: now, hr});
        prune(now);
        return true;
    }

    function prune(now) {
        const from = now - config.smoothingMs;
        while(samples.length > 1 && samples[0].t < from) samples.shift();
    }

    function smoothedHr(now) {
        prune(now);
        if(samples.length === 0) return null;
        const sum = samples.reduce((acc, s) => acc + s.hr, 0);
        return sum / samples.length;
    }

    function latestHr() {
        return samples.length ? samples[samples.length - 1].hr : null;
    }

    function output(now, status, changed = false, extra = {}) {
        lastStatus = status;
        return Object.assign({
            power:      Math.round(power),
            status,
            changed,
            target,
            smoothedHr: samples.length ? Math.round(smoothedHr(now)) : null,
            message:    messageFor(status),
        }, extra);
    }

    function messageFor(status) {
        switch(status) {
            case HrControlStatus.warmup:
                return 'Collecting heart rate…';
            case HrControlStatus.paused:
                return 'Not pedaling, holding power';
            case HrControlStatus.signalLost:
                return 'Heart rate signal lost, power frozen';
            case HrControlStatus.signalLostSafe:
                return 'Heart rate signal lost, power lowered';
            case HrControlStatus.ceiling:
                return 'Above max heart rate, lowering power';
            case HrControlStatus.active:
                return 'Holding target heart rate';
            default:
                return '';
        }
    }

    function setPower(value) {
        const prev = power;
        power = Math.round(value);
        return power !== prev;
    }

    // args: {pedaling: Bool} (default true)
    function tick(now, args = {}) {
        if(!running) return output(now, HrControlStatus.idle);

        const pedaling = args.pedaling ?? true;
        const b        = bounds();

        // bounds may have changed through configure()
        let changed = setPower(clamp(b.min, b.max, power));

        // 1. Signal loss
        const lastSeen = lastSampleAt ?? startedAt;
        const lostFor  = now - lastSeen;

        if(lostFor > config.staleMs) {
            // require a full warmup once the signal comes back
            samples   = [];
            dataStart = null;
            resetLoop();
            lastControlAt = now;

            if(lostFor >= config.dropAfterMs) {
                if(power > b.safe) changed = setPower(b.safe) || changed;
                return output(now, HrControlStatus.signalLostSafe, changed, {lostFor});
            }
            return output(now, HrControlStatus.signalLost, changed, {lostFor});
        }

        const hr = smoothedHr(now);

        // 2. Max HR ceiling, reacts to the latest reading, ignores warmup
        if(config.maxHr > 0 && hr !== null &&
           (latestHr() >= config.maxHr || hr >= config.maxHr)) {
            if(lastCeilingAt === null || (now - lastCeilingAt) >= config.intervalMs) {
                changed = setPower(clamp(b.min, b.max, power - config.ceilingStep)) || changed;
                lastCeilingAt = now;
            }
            resetLoop();
            lastControlAt = now;
            return output(now, HrControlStatus.ceiling, changed);
        }
        lastCeilingAt = null;

        // 3. Not pedaling, hold and don't integrate
        if(!pedaling) {
            resetLoop();
            lastControlAt = now;
            return output(now, HrControlStatus.paused, changed);
        }

        // 4. Not enough data yet (HR lags power)
        if(hr === null || dataStart === null || (now - dataStart) < config.warmupMs) {
            resetLoop();
            lastControlAt = now;
            return output(now, HrControlStatus.warmup, changed);
        }

        // 5. Control step
        if((now - lastControlAt) < config.intervalMs || target <= 0) {
            return output(now, HrControlStatus.active, changed);
        }

        const dt  = Math.min(now - lastControlAt, 2 * config.intervalMs) / 1000;
        let error = target - hr;
        if(Math.abs(error) <= config.deadband) error = 0;

        integral += config.ki * dt * error;

        const desired = base + config.kp * error + integral;
        const limited = clamp(power - config.maxStep, power + config.maxStep, desired);
        const out     = clamp(b.min, b.max, limited);

        // anti-windup: back-calculate the integrator from the applied output
        integral  = out - base - config.kp * error;
        lastError = error;
        lastControlAt = now;

        changed = setPower(out) || changed;

        return output(now, HrControlStatus.active, changed, {error});
    }

    function getState() {
        return {
            running,
            target,
            power,
            base,
            integral,
            lastError,
            dataStart,
            lastSampleAt,
            status: lastStatus,
            bounds: bounds(),
            samples: samples.length,
        };
    }

    return Object.freeze({
        configure,
        getConfig,
        bounds,
        start,
        stop,
        isRunning,
        setTarget,
        getTarget,
        addSample,
        smoothedHr,
        tick,
        getState,
    });
}

export {
    HrController,
    HrControlStatus,
    defaults,
};
