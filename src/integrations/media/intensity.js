//
// Intensity playlists: workout segment type -> playlist (pure logic).
//
// Flux workouts: workout.intervals = [{duration, steps: [{duration, power, slope?, cadence?}]}]
// step.power is a fraction of FTP when < 10 (e.g. 0.75), absolute watts otherwise
// (mirrors models.ftp.toAbsolute).
//

const SEGMENT_TYPES = ['warmup', 'endurance', 'threshold', 'vo2', 'recovery'];

const SEGMENT_LABELS = {
    warmup:    'Warm-up',
    endurance: 'Endurance',
    threshold: 'Tempo / Threshold',
    vo2:       'VO2 / Anaerobic',
    recovery:  'Recovery / Cool-down',
};

// Upper bounds (fraction of FTP) for each zone bucket
const DEFAULT_ZONES = {
    recovery:  0.56,  // < 56% FTP
    endurance: 0.76,  // 56-75%
    threshold: 1.06,  // 76-105% (tempo, sweet spot, threshold)
                      // >= 106% -> vo2
};

const MIN_ABS_VALUE = 10;

function powerFraction(power, ftp) {
    if(typeof power !== 'number' || !isFinite(power) || power <= 0) return null;
    if(power < MIN_ABS_VALUE) return power;
    if(!ftp || ftp <= 0) return null;
    return power / ftp;
}

function intervalDuration(interval = {}) {
    if(typeof interval.duration === 'number') return interval.duration;
    return (interval.steps || []).reduce((acc, s) => acc + (typeof s.duration === 'number' ? s.duration : 0), 0);
}

// time weighted average intensity of an interval (fraction of FTP), null if no power targets
function intervalIntensity(interval = {}, ftp) {
    let weighted = 0;
    let time = 0;
    for(const step of (interval.steps || [])) {
        const f = powerFraction(step.power, ftp);
        if(f === null) continue;
        const d = typeof step.duration === 'number' && step.duration > 0 ? step.duration : 1;
        weighted += f * d;
        time += d;
    }
    return time > 0 ? weighted / time : null;
}

function classifyIntensity(fraction, zones = DEFAULT_ZONES) {
    if(fraction === null || fraction === undefined || !isFinite(fraction)) return null;
    if(fraction < zones.recovery)  return 'recovery';
    if(fraction < zones.endurance) return 'endurance';
    if(fraction < zones.threshold) return 'threshold';
    return 'vo2';
}

const isHard = t => t === 'threshold' || t === 'vo2';
const isEasy = t => t === 'recovery' || t === 'endurance';

// Workout intervals -> segment type per interval index.
// - leading easy intervals (within warmupMaxSec, before the first hard one) -> 'warmup'
// - trailing easy intervals after the last hard one -> 'recovery' (cool-down)
// - short easy rests sandwiched between hard efforts keep the previous type, so
//   e.g. 30/30s or 3min/1min repeats don't flip playlists every interval
// - intervals without power targets (slope-only) inherit the previous type
function planSegments(intervals = [], ftp, {
    zones = DEFAULT_ZONES,
    warmupMaxSec = 20 * 60,
    minRestSec = 90,
} = {}) {
    const base = intervals.map(i => classifyIntensity(intervalIntensity(i, ftp), zones));
    const types = base.slice();
    const firstHard = base.findIndex(isHard);
    let lastHard = -1;
    base.forEach((t, i) => { if(isHard(t)) lastHard = i; });

    if(firstHard > 0) {
        let elapsed = 0;
        for(let i = 0; i < firstHard; i++) {
            elapsed += intervalDuration(intervals[i]);
            if(elapsed > warmupMaxSec) break;
            if(isEasy(base[i]) || base[i] === null) types[i] = 'warmup';
        }
    }

    if(lastHard >= 0) {
        for(let i = lastHard + 1; i < base.length; i++) {
            if(isEasy(base[i]) || base[i] === null) types[i] = 'recovery';
        }
    }

    for(let i = 1; i < base.length - 1; i++) {
        if(i <= firstHard || i >= lastHard) continue;
        if(isEasy(base[i]) && intervalDuration(intervals[i]) < minRestSec) {
            const prevHard = findPrev(types, i, isHard);
            const nextHard = findNext(base, i, isHard);
            if(prevHard !== null && nextHard !== null) types[i] = types[prevHard];
        }
    }

    for(let i = 0; i < types.length; i++) {
        if(types[i] === null && i > 0) types[i] = types[i - 1];
    }
    return types;
}

function findPrev(arr, i, pred) {
    for(let j = i - 1; j >= 0; j--) if(pred(arr[j])) return j;
    return null;
}
function findNext(arr, i, pred) {
    for(let j = i + 1; j < arr.length; j++) if(pred(arr[j])) return j;
    return null;
}

// mapping: {warmup: {uri, name}, endurance: {...}, ..., fallback?: {uri, name}}
function playlistFor(mapping = {}, type) {
    if(!type) return null;
    const entry = mapping[type];
    if(entry && entry.uri) return entry;
    if(mapping.fallback && mapping.fallback.uri) return mapping.fallback;
    return null;
}

// Decide whether to switch playback when the interval changes.
// -> {action: 'switch', uri, name, type} | {action: 'none', reason}
function switchDecision({
    enabled = true,
    type,
    mapping = {},
    currentContextUri = '',
    lastAppliedUri = '',
    spokenPlaying = false,
} = {}) {
    if(!enabled) return {action: 'none', reason: 'disabled'};
    if(!type) return {action: 'none', reason: 'no-segment-type'};
    if(spokenPlaying) return {action: 'none', reason: 'spoken-content'};
    const target = playlistFor(mapping, type);
    if(!target) return {action: 'none', reason: 'no-playlist'};
    if(target.uri === currentContextUri) return {action: 'none', reason: 'already-playing'};
    if(target.uri === lastAppliedUri && !currentContextUri) return {action: 'none', reason: 'already-applied'};
    return {action: 'switch', uri: target.uri, name: target.name || '', type};
}

// Auto pause on workout pause: only spoken content (music keeps going)
function shouldAutoPause({enabled = true, isPlaying = false, spoken = false} = {}) {
    return !!(enabled && isPlaying && spoken);
}

export {
    SEGMENT_TYPES,
    SEGMENT_LABELS,
    DEFAULT_ZONES,
    powerFraction,
    intervalDuration,
    intervalIntensity,
    classifyIntensity,
    planSegments,
    playlistFor,
    switchDecision,
    shouldAutoPause,
};
