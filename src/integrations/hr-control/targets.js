//
// Heart-rate targets: absolute bpm or a fraction of the rider's LTHR.
//
// The athlete's LTHR / max HR live in the analysis settings
// (localStorage 'analysis:lthr', 'analysis:max-hr', see ../analysis/settings.js);
// they are the single source of truth for HR zones and relative HR targets.
//
// A workout step's `heartRate` is stored as written in the workout file:
//   value <= 2   fraction of LTHR (zwo HeartRate="0.85" -> 85% LTHR)
//   value  > 2   bpm
// and resolved to bpm when the step starts, so changing LTHR later re-targets
// saved workouts.
//

import { athlete as analysisAthlete } from '../analysis/settings.js';

const RELATIVE_MAX = 2;

function athlete() {
    try {
        return analysisAthlete();
    } catch(e) {
        return {maxHr: null, lthr: null};
    }
}

function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

function isRelativeHeartRate(value) {
    return isNum(value) && value > 0 && value <= RELATIVE_MAX;
}

// value (bpm or fraction of LTHR) -> bpm (Int), or null when it can't be resolved
function toBpm(value, {lthr} = athlete()) {
    if(!isNum(value) || value <= 0) return null;
    if(isRelativeHeartRate(value)) {
        return isNum(lthr) && lthr > 0 ? Math.round(value * lthr) : null;
    }
    return Math.round(value);
}

// bpm -> % of LTHR (Int), or null without LTHR
function toLthrPct(bpm, {lthr} = athlete()) {
    if(!isNum(bpm) || bpm <= 0 || !isNum(lthr) || lthr <= 0) return null;
    return Math.round(100 * bpm / lthr);
}

// label for graphs / info: '142bpm', '85% LTHR (142bpm)', '85% LTHR'
function formatHeartRate(value, {lthr} = athlete()) {
    if(!isNum(value) || value <= 0) return '';
    if(isRelativeHeartRate(value)) {
        const bpm = toBpm(value, {lthr});
        const pct = `${Math.round(value * 100)}% LTHR`;
        return bpm === null ? pct : `${pct} (${bpm}bpm)`;
    }
    return `${Math.round(value)}bpm`;
}

export {
    RELATIVE_MAX,
    athlete,
    isRelativeHeartRate,
    toBpm,
    toLthrPct,
    formatHeartRate,
};
