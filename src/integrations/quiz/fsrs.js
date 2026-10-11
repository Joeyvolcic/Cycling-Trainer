//
// FSRS (Free Spaced Repetition Scheduler) — pure implementation of FSRS-5.
//
// Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
// No DOM, no storage, no clock: callers pass `now` (ms since epoch) so this is
// fully deterministic and unit-testable.
//
// Scheduling state lives in `card.srs`:
//   { state, due, stability, difficulty, step, reps, lapses, lastReview, scheduledDays }
//

const Rating = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
const State  = Object.freeze({
    new: 'new', learning: 'learning', review: 'review', relearning: 'relearning',
});

const MINUTE = 60 * 1000;
const DAY    = 24 * 60 * MINUTE;

// FSRS-5 default weights (trained on the open-spaced-repetition dataset)
const defaultWeights = Object.freeze([
    0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
    0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
]);

const DECAY  = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19/81

const defaultParams = Object.freeze({
    w: defaultWeights,
    requestRetention: 0.9,
    maximumInterval: 36500,          // days
    learningSteps:   [1, 10],        // minutes
    relearningSteps: [10],           // minutes
    enableFuzz: false,
});

function params(overrides = {}) {
    return Object.assign({}, defaultParams, overrides);
}

function clamp(x, min, max) {
    return Math.min(Math.max(x, min), max);
}

function newSrs(now = Date.now()) {
    return {
        state: State.new,
        due: now,
        stability: 0,
        difficulty: 0,
        step: 0,
        reps: 0,
        lapses: 0,
        lastReview: null,
        scheduledDays: 0,
    };
}

// Probability of recall after `elapsedDays` with stability `stability`
function retrievability(elapsedDays, stability) {
    if(!(stability > 0)) return 0;
    return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
}

function initStability(w, rating) {
    return Math.max(w[rating - 1], 0.1);
}

function initDifficulty(w, rating) {
    return clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
}

function nextDifficulty(w, d, rating) {
    const delta  = -w[6] * (rating - 3);
    const damped = d + delta * (10 - d) / 9;              // linear damping (FSRS-5)
    const target = initDifficulty(w, Rating.easy);        // mean reversion target
    return clamp(w[7] * target + (1 - w[7]) * damped, 1, 10);
}

function recallStability(w, d, s, r, rating) {
    const hardPenalty = rating === Rating.hard ? w[15] : 1;
    const easyBonus   = rating === Rating.easy ? w[16] : 1;
    return s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) *
                (Math.exp(w[10] * (1 - r)) - 1) * hardPenalty * easyBonus);
}

function forgetStability(w, d, s, r) {
    const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) *
               Math.exp(w[14] * (1 - r));
    // a lapse can never increase stability (FSRS-5 also caps by the short-term curve)
    return Math.min(sf, s / Math.exp(w[17] * w[18]));
}

function shortTermStability(w, s, rating) {
    return s * Math.exp(w[17] * (rating - 3 + w[18]));
}

// Days until recall probability drops to requestRetention
function nextInterval(p, stability, rand = null) {
    const raw = stability / FACTOR * (Math.pow(p.requestRetention, 1 / DECAY) - 1);
    let days  = clamp(Math.round(raw), 1, p.maximumInterval);
    if(p.enableFuzz && rand && days >= 3) {
        const range = Math.max(1, Math.round(days * 0.05));
        days = days - range + Math.floor(rand() * (2 * range + 1));
    }
    return clamp(days, 1, p.maximumInterval);
}

function elapsedDays(srs, now) {
    if(srs.lastReview === null || srs.lastReview === undefined) return 0;
    return Math.max(0, (now - srs.lastReview) / DAY);
}

function toReview(srs, p, days, now) {
    srs.state = State.review;
    srs.step = 0;
    srs.scheduledDays = days;
    srs.due = now + days * DAY;
    return srs;
}

function toStep(srs, state, steps, step, now, minutes) {
    srs.state = state;
    srs.step = step;
    srs.scheduledDays = 0;
    srs.due = now + Math.round(minutes * MINUTE);
    return srs;
}

// Learning/relearning step handling (shared by new, learning, relearning)
function stepScheduling(srs, p, rating, now, state) {
    const steps = state === State.relearning ? p.relearningSteps : p.learningSteps;
    if(steps.length === 0) {
        return toReview(srs, p, nextInterval(p, srs.stability), now);
    }
    const step = Math.min(srs.step, steps.length - 1);
    switch(rating) {
    case Rating.again:
        return toStep(srs, state, steps, 0, now, steps[0]);
    case Rating.hard: {
        // first step: halfway between step 1 and 2; otherwise repeat the step
        const minutes = (step === 0 && steps.length > 1) ?
              (steps[0] + steps[1]) / 2 : steps[step] * (steps.length === 1 ? 1.5 : 1);
        return toStep(srs, state, steps, step, now, minutes);
    }
    case Rating.good:
        if(step + 1 < steps.length) {
            return toStep(srs, state, steps, step + 1, now, steps[step + 1]);
        }
        return toReview(srs, p, nextInterval(p, srs.stability), now);
    case Rating.easy:
    default:
        return toReview(srs, p, nextInterval(p, srs.stability), now);
    }
}

//
// review(srs, rating, now, params) -> { srs, log }
// Does not mutate the input.
//
function review(prev, rating, now = Date.now(), overrides = {}, rand = null) {
    if(![1, 2, 3, 4].includes(rating)) {
        throw new Error(`fsrs: invalid rating ${rating}`);
    }
    const p   = params(overrides);
    const w   = p.w;
    const srs = Object.assign(newSrs(now), prev || {});
    const t   = elapsedDays(srs, now);
    const r   = srs.state === State.new ? 1 : retrievability(t, srs.stability);
    const log = {
        rating, state: srs.state, due: srs.due, elapsedDays: t,
        retrievability: r, stability: srs.stability, difficulty: srs.difficulty,
        review: now,
    };

    switch(srs.state) {
    case State.new:
        srs.difficulty = initDifficulty(w, rating);
        srs.stability  = initStability(w, rating);
        stepScheduling(srs, p, rating, now, State.learning);
        break;

    case State.learning:
    case State.relearning:
        srs.difficulty = nextDifficulty(w, srs.difficulty, rating);
        srs.stability  = shortTermStability(w, srs.stability, rating);
        stepScheduling(srs, p, rating, now, srs.state);
        break;

    case State.review:
    default: {
        srs.difficulty = nextDifficulty(w, srs.difficulty, rating);
        if(rating === Rating.again) {
            srs.stability = forgetStability(w, log.difficulty, srs.stability, r);
            srs.lapses += 1;
            if(p.relearningSteps.length > 0) {
                srs.step = 0;
                toStep(srs, State.relearning, p.relearningSteps, 0, now, p.relearningSteps[0]);
            } else {
                toReview(srs, p, nextInterval(p, srs.stability), now);
            }
            break;
        }
        // compute all three so that hard <= good < easy holds
        const s = {};
        [Rating.hard, Rating.good, Rating.easy].forEach(g => {
            s[g] = recallStability(w, log.difficulty, srs.stability, r, g);
        });
        let hard = nextInterval(p, s[Rating.hard], rand);
        let good = nextInterval(p, s[Rating.good], rand);
        let easy = nextInterval(p, s[Rating.easy], rand);
        hard = Math.min(hard, good);
        good = Math.max(good, hard + 1);
        easy = Math.max(easy, good + 1);
        const days = clamp({[Rating.hard]: hard, [Rating.good]: good, [Rating.easy]: easy}[rating],
                           1, p.maximumInterval);
        srs.stability = s[rating];
        toReview(srs, p, days, now);
        break;
    }
    }

    srs.reps += 1;
    srs.lastReview = now;
    return { srs, log };
}

// Preview the due time for each rating (for showing "1m / 10m / 1d / 4d" on buttons)
function preview(srs, now = Date.now(), overrides = {}) {
    const out = {};
    [Rating.again, Rating.hard, Rating.good, Rating.easy].forEach(g => {
        out[g] = review(srs, g, now, overrides).srs.due - now;
    });
    return out;
}

function formatInterval(ms) {
    if(ms < MINUTE) return '<1m';
    if(ms < 60 * MINUTE) return `${Math.round(ms / MINUTE)}m`;
    if(ms < DAY) return `${Math.round(ms / (60 * MINUTE))}h`;
    const days = ms / DAY;
    if(days < 30) return `${Math.round(days)}d`;
    if(days < 365) return `${Math.round(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
}

export {
    Rating,
    State,
    MINUTE,
    DAY,
    defaultWeights,
    defaultParams,
    newSrs,
    retrievability,
    initStability,
    initDifficulty,
    nextDifficulty,
    nextInterval,
    review,
    preview,
    formatInterval,
};
