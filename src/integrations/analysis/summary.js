//
// Ride summary for post-ride analysis (see doc/integrations-contract.md)
//
// summarizeActivity(activity, options) -> plain JSON
//
// `activity` is a plain object, deliberately decoupled from the app's db so it
// can be built from the live session or from what we persist in IDB:
//
// {
//     id?, name?, timestamp?,
//     records: [{timestamp, power, heart_rate, cadence, ...}], // ~1Hz samples (entries
//                                                              // without timestamp, e.g.
//                                                              // RR intervals, are ignored)
//     // or, instead of records, compact streams:
//     streams?: {timestamp: [], power: [], heart_rate: [], cadence: []},
//     laps?: [{start_time, timestamp}],     // lap boundaries (ms epoch)
//     workout?: {meta: {name}, intervals: [{duration, steps: [{duration, power?, cadence?, slope?}]}]},
//     workoutLapOffset?: Int,               // laps recorded before the workout was started
//     ftp?: Int, maxHr?: Int, lthr?: Int,
// }
//
// No DOM / app imports here: pure functions, unit tested in test/integrations/analysis.
//

const SUMMARY_VERSION = 1;

// Coggan power zones, upper bounds as fraction of FTP
const POWER_ZONES = [
    {zone: 'Z1', name: 'Active Recovery', max: 0.55},
    {zone: 'Z2', name: 'Endurance',       max: 0.75},
    {zone: 'Z3', name: 'Tempo',           max: 0.90},
    {zone: 'Z4', name: 'Threshold',       max: 1.05},
    {zone: 'Z5', name: 'VO2max',          max: 1.20},
    {zone: 'Z6', name: 'Anaerobic',       max: 1.50},
    {zone: 'Z7', name: 'Neuromuscular',   max: Infinity},
];

// Friel zones as fraction of LTHR (Z5 collapsed)
const HR_ZONES_LTHR = [
    {zone: 'Z1', name: 'Recovery',  max: 0.81},
    {zone: 'Z2', name: 'Aerobic',   max: 0.90},
    {zone: 'Z3', name: 'Tempo',     max: 0.94},
    {zone: 'Z4', name: 'Threshold', max: 1.00},
    {zone: 'Z5', name: 'Anaerobic', max: Infinity},
];

// % of max HR
const HR_ZONES_MAX = [
    {zone: 'Z1', name: 'Recovery',  max: 0.60},
    {zone: 'Z2', name: 'Aerobic',   max: 0.70},
    {zone: 'Z3', name: 'Tempo',     max: 0.80},
    {zone: 'Z4', name: 'Threshold', max: 0.90},
    {zone: 'Z5', name: 'Anaerobic', max: Infinity},
];

// app convention (models.ftp.toAbsolute): values below this are fractions of FTP
const MIN_ABS_POWER = 9;
const COMPLIANCE_TOLERANCE = 0.05;

function isNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

function round(x, digits = 0) {
    if(!isNum(x)) return null;
    const f = Math.pow(10, digits);
    return Math.round(x * f) / f;
}

function mean(xs) {
    if(xs.length === 0) return null;
    let s = 0;
    for(const x of xs) s += x;
    return s / xs.length;
}

function maxOf(xs) {
    if(xs.length === 0) return null;
    let m = -Infinity;
    for(const x of xs) if(x > m) m = x;
    return m;
}

function minOf(xs) {
    if(xs.length === 0) return null;
    let m = Infinity;
    for(const x of xs) if(x < m) m = x;
    return m;
}

// Normalized Power: 30s rolling average, 4th power mean, 4th root
function normalizedPower(power = []) {
    if(power.length === 0) return null;
    if(power.length < 30) return mean(power);
    let sum = 0;
    for(let i = 0; i < 30; i++) sum += power[i];
    let acc = 0;
    let n = 0;
    for(let i = 29; i < power.length; i++) {
        if(i > 29) sum += power[i] - power[i - 30];
        acc += Math.pow(sum / 30, 4);
        n++;
    }
    return Math.pow(acc / n, 0.25);
}

// -> [{timestamp, power, heart_rate, cadence}]
function toSamples(activity = {}) {
    if(Array.isArray(activity.records) && activity.records.length > 0) {
        return activity.records
            .filter(r => r && isNum(r.timestamp))
            .map(r => ({
                timestamp:  r.timestamp,
                power:      isNum(r.power) ? r.power : 0,
                heart_rate: isNum(r.heart_rate) ? r.heart_rate : 0,
                cadence:    isNum(r.cadence) ? r.cadence : 0,
            }));
    }
    const s = activity.streams;
    if(s && Array.isArray(s.power)) {
        const n = s.power.length;
        const t0 = activity.timestamp ?? 0;
        const samples = [];
        for(let i = 0; i < n; i++) {
            samples.push({
                timestamp:  s.timestamp?.[i] ?? (t0 + i * 1000),
                power:      s.power[i] ?? 0,
                heart_rate: s.heart_rate?.[i] ?? 0,
                cadence:    s.cadence?.[i] ?? 0,
            });
        }
        return samples;
    }
    return [];
}

// Compact persisted form of the samples, so a summary can be recomputed later
function toStreams(activity = {}) {
    const samples = toSamples(activity);
    return {
        timestamp:  samples.map(s => s.timestamp),
        power:      samples.map(s => s.power),
        heart_rate: samples.map(s => s.heart_rate),
        cadence:    samples.map(s => s.cadence),
    };
}

function zoneTable(values, defs, reference, unit) {
    if(!isNum(reference) || reference <= 0) return null;
    const out = defs.map((d, i) => ({
        zone: d.zone,
        name: d.name,
        min: i === 0 ? 0 : Math.round(defs[i - 1].max * reference),
        max: d.max === Infinity ? null : Math.round(d.max * reference) - 1,
        unit,
        seconds: 0,
        pct: 0,
    }));
    let total = 0;
    for(const v of values) {
        if(!isNum(v)) continue;
        const r = v / reference;
        let idx = defs.findIndex(d => r < d.max);
        if(idx < 0) idx = defs.length - 1;
        out[idx].seconds += 1;
        total += 1;
    }
    out.forEach(z => z.pct = total > 0 ? round(z.seconds / total * 100, 1) : 0);
    return out;
}

// Aerobic decoupling (Pw:HR) between the 1st and 2nd half of the ride
function decoupling(samples) {
    const valid = samples.filter(s => s.heart_rate > 0);
    if(valid.length < 120) return null; // need at least ~2 minutes with HR
    const half = Math.floor(valid.length / 2);
    const a = valid.slice(0, half);
    const b = valid.slice(half);
    const pa = mean(a.map(s => s.power)), ha = mean(a.map(s => s.heart_rate));
    const pb = mean(b.map(s => s.power)), hb = mean(b.map(s => s.heart_rate));
    const efA = ha > 0 ? pa / ha : null;
    const efB = hb > 0 ? pb / hb : null;
    return {
        firstHalf:  {avgPower: round(pa), avgHr: round(ha), efficiencyFactor: round(efA, 3)},
        secondHalf: {avgPower: round(pb), avgHr: round(hb), efficiencyFactor: round(efB, 3)},
        // positive = HR rose relative to power in the 2nd half (< 5% is usually considered well coupled)
        decouplingPct: (efA && efB) ? round((efA - efB) / efA * 100, 1) : null,
        hrDriftPct: ha > 0 ? round((hb - ha) / ha * 100, 1) : null,
    };
}

function absPower(value, ftp) {
    if(!isNum(value)) return null;
    if(value < MIN_ABS_POWER) return isNum(ftp) && ftp > 0 ? value * ftp : null;
    return value;
}

// duration-weighted planned targets of an interval
function intervalTarget(interval = {}, ftp) {
    const steps = interval.steps ?? [];
    let dur = 0, powerAcc = 0, powerDur = 0, cadAcc = 0, cadDur = 0;
    let hasSlope = false;
    for(const step of steps) {
        const d = isNum(step.duration) ? step.duration : 0;
        dur += d;
        const p = absPower(step.power, ftp);
        if(isNum(p) && (step.power > 0)) { powerAcc += p * d; powerDur += d; }
        if(isNum(step.cadence) && step.cadence > 0) { cadAcc += step.cadence * d; cadDur += d; }
        if(isNum(step.slope)) hasSlope = true;
    }
    const plannedSec = isNum(interval.duration) ? interval.duration : dur;
    return {
        plannedSec,
        // only meaningful when every step had a power target
        targetPower: (powerDur > 0 && powerDur === dur && !hasSlope) ? powerAcc / powerDur : null,
        targetCadence: cadDur > 0 ? cadAcc / cadDur : null,
    };
}

function segmentByLaps(samples, laps, offset, count) {
    const segs = [];
    const usable = laps.slice(offset).filter(l => isNum(l.start_time) && isNum(l.timestamp));
    for(let i = 0; i < Math.min(usable.length, count); i++) {
        const lap = usable[i];
        segs.push(samples.filter(s => s.timestamp >= lap.start_time && s.timestamp < lap.timestamp));
    }
    return segs;
}

function segmentByDuration(samples, intervals, startIndex = 0) {
    const segs = [];
    let i = startIndex;
    for(const interval of intervals) {
        if(i >= samples.length) break;
        const d = Math.max(0, Math.round(interval.duration ?? 0));
        segs.push(samples.slice(i, i + d));
        i += d;
    }
    return segs;
}

function intervalCompliance(samples, activity, ftp) {
    const intervals = activity.workout?.intervals;
    if(!Array.isArray(intervals) || intervals.length === 0 || samples.length === 0) return null;

    const laps = Array.isArray(activity.laps) ? activity.laps : [];
    const offset = activity.workoutLapOffset ?? 0;
    const lapSegs = segmentByLaps(samples, laps, offset, intervals.length);
    // laps mark the real interval transitions (they also account for skipped / extended
    // intervals); fall back to the planned durations when there are no laps
    const segs = lapSegs.length > 0 ?
          lapSegs :
          segmentByDuration(samples, intervals, activity.workoutStartIndex ?? 0);
    const method = lapSegs.length > 0 ? 'laps' : 'duration';

    const rows = [];
    let scoreAcc = 0, scoreDur = 0, within = 0, withTarget = 0;

    segs.forEach((seg, index) => {
        const planned = intervalTarget(intervals[index], ftp);
        const power = seg.map(s => s.power);
        const hr = seg.map(s => s.heart_rate).filter(x => x > 0);
        const cad = seg.map(s => s.cadence).filter(x => x > 0);
        const actualPower = mean(power);
        let compliancePct = null;
        let status = 'no-target';

        if(isNum(planned.targetPower) && isNum(actualPower) && planned.targetPower > 0) {
            const ratio = actualPower / planned.targetPower;
            compliancePct = round(ratio * 100, 1);
            const dev = Math.abs(ratio - 1);
            status = dev <= COMPLIANCE_TOLERANCE ? 'on-target' : (ratio < 1 ? 'under' : 'over');
            withTarget += 1;
            if(dev <= COMPLIANCE_TOLERANCE) within += 1;
            const score = Math.max(0, 100 - dev * 100);
            scoreAcc += score * seg.length;
            scoreDur += seg.length;
        }

        rows.push({
            index,
            plannedSec: round(planned.plannedSec),
            actualSec: seg.length,
            targetPower: round(planned.targetPower),
            avgPower: round(actualPower),
            maxPower: round(maxOf(power)),
            compliancePct,
            status,
            targetCadence: round(planned.targetCadence),
            avgCadence: round(mean(cad)),
            avgHr: round(mean(hr)),
            maxHr: round(maxOf(hr)),
        });
    });

    const plannedSec = intervals.reduce((acc, i) => acc + intervalTarget(i, ftp).plannedSec, 0);
    const completedSec = rows.reduce((acc, r) => acc + r.actualSec, 0);

    return {
        method,
        tolerancePct: COMPLIANCE_TOLERANCE * 100,
        plannedIntervals: intervals.length,
        completedIntervals: rows.length,
        plannedSec: round(plannedSec),
        completedSec,
        intervalsWithTarget: withTarget,
        intervalsOnTarget: within,
        // 0-100, time-weighted: 100 = every interval exactly on target
        score: scoreDur > 0 ? round(scoreAcc / scoreDur, 1) : null,
        intervals: rows,
    };
}

function summarizeActivity(activity = {}, options = {}) {
    const samples = toSamples(activity);
    const ftp = options.ftp ?? activity.ftp ?? null;
    const maxHrSetting = options.maxHr ?? activity.maxHr ?? null;
    const lthr = options.lthr ?? activity.lthr ?? null;

    const power = samples.map(s => s.power);
    const hrAll = samples.map(s => s.heart_rate).filter(x => x > 0);
    const cadAll = samples.map(s => s.cadence).filter(x => x > 0);

    const durationSec = samples.length;
    const first = samples[0], last = samples[samples.length - 1];
    const elapsedSec = samples.length > 1 ? Math.round((last.timestamp - first.timestamp) / 1000) + 1 : durationSec;
    const movingSec = samples.filter(s => s.power > 0 || s.cadence > 0).length;

    const avgPower = mean(power);
    const np = normalizedPower(power);
    const hasFtp = isNum(ftp) && ftp > 0;
    const intensityFactor = hasFtp && isNum(np) ? np / ftp : null;
    const tss = hasFtp && isNum(np) ? (durationSec * np * intensityFactor) / (ftp * 3600) * 100 : null;
    const workKj = power.reduce((a, p) => a + p, 0) / 1000;

    let hrZones = null;
    let hrZoneBasis = null;
    if(isNum(lthr) && lthr > 0) {
        hrZones = zoneTable(hrAll, HR_ZONES_LTHR, lthr, 'bpm');
        hrZoneBasis = 'lthr';
    } else if(isNum(maxHrSetting) && maxHrSetting > 0) {
        hrZones = zoneTable(hrAll, HR_ZONES_MAX, maxHrSetting, 'bpm');
        hrZoneBasis = 'maxHr';
    }

    const workout = activity.workout;

    return {
        version: SUMMARY_VERSION,
        id: activity.id ?? null,
        name: activity.name ?? workout?.meta?.name ?? null,
        startTime: first ? new Date(first.timestamp).toISOString() : null,
        durationSec,
        elapsedSec,
        movingSec,
        ftp: hasFtp ? ftp : null,
        power: {
            avg: round(avgPower),
            max: round(maxOf(power)),
            normalized: round(np),
            variabilityIndex: (isNum(np) && avgPower > 0) ? round(np / avgPower, 2) : null,
            intensityFactor: round(intensityFactor, 2),
            tss: round(tss),
            workKj: round(workKj),
        },
        heartRate: hrAll.length > 0 ? {
            avg: round(mean(hrAll)),
            max: round(maxOf(hrAll)),
            min: round(minOf(hrAll)),
            decoupling: decoupling(samples),
        } : null,
        cadence: cadAll.length > 0 ? {
            avg: round(mean(cadAll)),
            max: round(maxOf(cadAll)),
        } : null,
        zones: {
            power: hasFtp ? zoneTable(power, POWER_ZONES, ftp, 'W') : null,
            heartRate: hrZones,
            heartRateBasis: hrZoneBasis,
        },
        planned: workout ? {
            name: workout.meta?.name ?? null,
            description: workout.meta?.description ?? null,
            plannedSec: Array.isArray(workout.intervals) ?
                round(workout.intervals.reduce((a, i) => a + intervalTarget(i, ftp).plannedSec, 0)) : null,
        } : null,
        compliance: intervalCompliance(samples, activity, ftp),
    };
}

export {
    summarizeActivity,
    normalizedPower,
    toSamples,
    toStreams,
    POWER_ZONES,
};
