//
// Ride state -> "may I show a card now?" — pure logic, fed by xf events in index.js.
//
// Intensity is derived from the current power target (ERG / workout step) as a
// fraction of FTP, falling back to 3s power when there is no target.
//
//   recovery  < 60% FTP
//   endurance 60-80%
//   tempo     80-90%   ("moderate")
//   work      >= 90%   (threshold, VO2, anaerobic)
//
// The research link between moderate exercise and memory consolidation is
// promising but not settled, so every policy here is a user setting.
//

const Zone = Object.freeze({
    idle: 'idle',            // not riding (watch stopped/paused) — study freely
    unknown: 'unknown',      // riding but no target/power yet
    recovery: 'recovery',
    endurance: 'endurance',
    tempo: 'tempo',
    work: 'work',
});

const SessionMode = Object.freeze({
    always: 'always',
    work: 'work',            // during work intervals
    recovery: 'recovery',    // during recovery only
});

const NewCardPolicy = Object.freeze({
    anytime: 'anytime',
    suggested: 'suggested',  // new cards at moderate intensity / right after intervals; reviews in steady endurance
    never: 'never',          // never introduce new cards during a ride
});

const defaultThresholds = Object.freeze({ recovery: 0.60, endurance: 0.80, tempo: 0.90 });

function classify(watts, ftp, thresholds = defaultThresholds) {
    if(!(watts > 0) || !(ftp > 0)) return Zone.unknown;
    const x = watts / ftp;
    if(x < thresholds.recovery)  return Zone.recovery;
    if(x < thresholds.endurance) return Zone.endurance;
    if(x < thresholds.tempo)     return Zone.tempo;
    return Zone.work;
}

// Is the session mode satisfied in this zone?
function sessionAllows(mode, zone) {
    if(zone === Zone.idle || mode === SessionMode.always) return true;
    if(mode === SessionMode.work) return zone === Zone.work || zone === Zone.tempo;
    if(mode === SessionMode.recovery) return zone === Zone.recovery || zone === Zone.unknown;
    return true;
}

// May new (never-seen) cards be introduced right now?
function newCardsAllowed(policy, zone, afterInterval = false) {
    if(zone === Zone.idle) return true;
    switch(policy) {
    case NewCardPolicy.never: return false;
    case NewCardPolicy.suggested:
        return afterInterval || zone === Zone.tempo || zone === Zone.unknown;
    case NewCardPolicy.anytime:
    default: return true;
    }
}

//
// Small state machine. Call update() with whatever changed; read gate().
//
class RideState {
    constructor({ now = () => Date.now(), afterIntervalMs = 3 * 60 * 1000, thresholds } = {}) {
        this.now = now;
        this.afterIntervalMs = afterIntervalMs;
        this.thresholds = thresholds || defaultThresholds;
        this.ftp = 0;
        this.powerTarget = 0;
        this.power = 0;
        this.running = false;
        this.zone = Zone.idle;
        this.lastWorkEnd = -Infinity;
    }
    update(patch = {}) {
        Object.assign(this, patch);
        const prev = this.zone;
        const watts = this.powerTarget > 0 ? this.powerTarget : this.power;
        this.zone = this.running ? classify(watts, this.ftp, this.thresholds) : Zone.idle;
        if(prev === Zone.work && this.zone !== Zone.work && this.running) {
            this.lastWorkEnd = this.now();
        }
        return this.zone;
    }
    afterInterval() {
        return this.now() - this.lastWorkEnd <= this.afterIntervalMs;
    }
    gate({ mode = SessionMode.always, newPolicy = NewCardPolicy.anytime } = {}) {
        const after = this.afterInterval();
        return {
            zone: this.zone,
            afterInterval: after,
            show: sessionAllows(mode, this.zone),
            allowNew: newCardsAllowed(newPolicy, this.zone, after),
        };
    }
}

export {
    Zone,
    SessionMode,
    NewCardPolicy,
    defaultThresholds,
    classify,
    sessionAllows,
    newCardsAllowed,
    RideState,
};
