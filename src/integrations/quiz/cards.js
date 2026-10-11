//
// Card model, cloze rendering, due queue and stats — pure functions.
//
// Card = {
//   id, deckId, type: 'basic' | 'cloze' | 'mcq',
//   front, back,                 // basic + mcq (back = optional explanation)
//   text, cloze,                 // cloze: source text with {{cN::answer::hint}} and N
//   choices: [string], answer,   // mcq: options and index of the correct one
//   tags: [string], created, updated,
//   srs: { ...see fsrs.js newSrs() }
// }
//

import { newSrs, retrievability, State, DAY } from './fsrs.js';

const CardType = Object.freeze({ basic: 'basic', cloze: 'cloze', mcq: 'mcq' });

const clozeRegex = () => /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

function uid() {
    if(typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'q-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function clean(x) {
    return (x === undefined || x === null) ? '' : String(x).trim();
}

function clozeNumbers(text = '') {
    const set = new Set();
    for(const m of String(text).matchAll(clozeRegex())) set.add(parseInt(m[1]));
    return Array.from(set).sort((a, b) => a - b);
}

function hasCloze(text = '') {
    return clozeNumbers(text).length > 0;
}

// Front: target deletion -> [...] (or [hint]); other deletions show their answer
function renderClozeFront(text, n) {
    return String(text).replace(clozeRegex(), (_, num, answer, hint) =>
        parseInt(num) === n ? `[${hint ? hint : '...'}]` : answer);
}

// Back: everything revealed; `mark` wraps the target answer (e.g. for highlighting)
function renderClozeBack(text, n, mark = (x) => x) {
    return String(text).replace(clozeRegex(), (_, num, answer) =>
        parseInt(num) === n ? mark(answer) : answer);
}

function clozeAnswer(text, n) {
    const out = [];
    for(const m of String(text).matchAll(clozeRegex())) {
        if(parseInt(m[1]) === n) out.push(m[2]);
    }
    return out.join(', ');
}

// Plain question/answer strings for any card type (used by UI and speech)
function question(card) {
    if(card.type === CardType.cloze) return renderClozeFront(card.text, card.cloze);
    return card.front;
}

function answer(card) {
    if(card.type === CardType.cloze) return clozeAnswer(card.text, card.cloze);
    if(card.type === CardType.mcq) {
        const a = card.choices[card.answer];
        return card.back ? `${a}. ${card.back}` : a;
    }
    return card.back;
}

// Validate + normalize raw input into one or more cards. Invalid -> [].
// A cloze source with c1 and c2 expands to two cards.
function makeCards(raw = {}, {deckId = 'default', now = Date.now()} = {}) {
    const base = {
        deckId: raw.deckId || deckId,
        tags: Array.isArray(raw.tags) ? raw.tags.map(clean).filter(Boolean) :
              clean(raw.tags).split(/\s+/).filter(Boolean),
        created: raw.created || now,
        updated: now,
    };
    let type = raw.type;
    if(!type) {
        if(Array.isArray(raw.choices) && raw.choices.length > 1) type = CardType.mcq;
        else if(hasCloze(raw.text || raw.front)) type = CardType.cloze;
        else type = CardType.basic;
    }

    if(type === CardType.cloze) {
        const text = clean(raw.text || raw.front);
        const nums = raw.cloze ? [parseInt(raw.cloze)] : clozeNumbers(text);
        return nums.filter(n => clozeNumbers(text).includes(n)).map(n => Object.assign({}, base, {
            id: (nums.length === 1 && raw.id) ? raw.id : uid(),
            type, text, cloze: n, front: '', back: clean(raw.back),
            srs: raw.srs || newSrs(now),
        }));
    }

    if(type === CardType.mcq) {
        const choices = (raw.choices || []).map(clean).filter(Boolean);
        let ans = raw.answer;
        if(typeof ans === 'string' && !/^\d+$/.test(ans)) ans = choices.indexOf(clean(ans));
        ans = parseInt(ans);
        const front = clean(raw.front || raw.question);
        if(!front || choices.length < 2 || !(ans >= 0 && ans < choices.length)) return [];
        return [Object.assign({}, base, {
            id: raw.id || uid(), type, front, back: clean(raw.back || raw.explanation),
            choices, answer: ans, srs: raw.srs || newSrs(now),
        })];
    }

    const front = clean(raw.front || raw.question);
    const back  = clean(raw.back || raw.answer);
    if(!front || !back) return [];
    return [Object.assign({}, base, {
        id: raw.id || uid(), type: CardType.basic, front, back, srs: raw.srs || newSrs(now),
    })];
}

function isNew(card) {
    return !card.srs || card.srs.state === State.new;
}

function isLearning(card) {
    return card.srs && (card.srs.state === State.learning || card.srs.state === State.relearning);
}

function isSuspended(card) {
    return !!card.suspended;
}

//
// buildQueue(cards, now, opts) -> ordered array of cards to study now.
//   1. learning/relearning cards that are due (soonest first)
//   2. review cards that are due (lowest retrievability first: most at risk)
//   3. new cards (oldest first), at most `newLimit`, only if `allowNew`
//   If nothing else is available, learning cards due within `learnAheadMs`
//   are pulled forward so a ride doesn't stall on a 10-minute step.
//
function buildQueue(cards = [], now = Date.now(), opts = {}) {
    const { allowNew = true, newLimit = 10, learnAheadMs = 20 * 60 * 1000, deckId = null } = opts;
    const pool = cards.filter(c => !isSuspended(c) && (!deckId || c.deckId === deckId));

    const learning = pool.filter(c => isLearning(c) && c.srs.due <= now)
                         .sort((a, b) => a.srs.due - b.srs.due);

    const reviewDue = pool.filter(c => c.srs && c.srs.state === State.review && c.srs.due <= now)
                          .map(c => [c, retrievability((now - c.srs.lastReview) / DAY, c.srs.stability)])
                          .sort((a, b) => (a[1] - b[1]) || (a[0].srs.due - b[0].srs.due))
                          .map(x => x[0]);

    const fresh = allowNew ?
          pool.filter(isNew).sort((a, b) => (a.created - b.created)).slice(0, Math.max(0, newLimit)) :
          [];

    const queue = [...learning, ...reviewDue, ...fresh];
    if(queue.length > 0) return queue;

    return pool.filter(c => isLearning(c) && c.srs.due <= now + learnAheadMs)
               .sort((a, b) => a.srs.due - b.srs.due);
}

function endOfDay(now) {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
}

function startOfDay(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// logs: [{cardId, rating, state, review, ...}] (state = state *before* the review)
function stats(cards = [], logs = [], now = Date.now(), {rideStart = null, newPerDay = 20} = {}) {
    const eod = endOfDay(now);
    const sod = startOfDay(now);
    const active = cards.filter(c => !isSuspended(c));
    const dueToday = active.filter(c => !isNew(c) && c.srs.due <= eod).length;
    const newCount = active.filter(isNew).length;
    const newToday = logs.filter(l => l.review >= sod && l.state === State.new).length;

    const matured = logs.filter(l => l.state === State.review);
    const retention = matured.length ?
          matured.filter(l => l.rating > 1).length / matured.length : null;

    const ride = rideStart === null ? [] : logs.filter(l => l.review >= rideStart);
    return {
        total: active.length,
        dueToday,
        newAvailable: Math.max(0, Math.min(newCount, newPerDay - newToday)),
        reviewedToday: logs.filter(l => l.review >= sod).length,
        reviewedThisRide: ride.length,
        rideCorrect: ride.filter(l => l.rating > 1).length,
        retention,                     // fraction 0..1, or null if no mature reviews yet
        retentionSample: matured.length,
    };
}

export {
    CardType,
    uid,
    clozeNumbers,
    hasCloze,
    renderClozeFront,
    renderClozeBack,
    clozeAnswer,
    question,
    answer,
    makeCards,
    isNew,
    isLearning,
    buildQueue,
    stats,
    startOfDay,
    endOfDay,
};
