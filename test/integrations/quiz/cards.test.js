import {
    makeCards, clozeNumbers, renderClozeFront, renderClozeBack, clozeAnswer,
    question, answer, buildQueue, stats,
} from '../../../src/integrations/quiz/cards.js';
import { review, newSrs, Rating, State, DAY, MINUTE } from '../../../src/integrations/quiz/fsrs.js';

const T0 = Date.UTC(2026, 0, 10, 12);

describe('cloze', () => {
    const text = 'The {{c1::mitochondria}} is the {{c2::powerhouse::role}} of the cell';
    test('numbers, front, back, answer', () => {
        expect(clozeNumbers(text)).toEqual([1, 2]);
        expect(renderClozeFront(text, 1)).toBe('The [...] is the powerhouse of the cell');
        expect(renderClozeFront(text, 2)).toBe('The mitochondria is the [role] of the cell');
        expect(renderClozeBack(text, 2, a => `*${a}*`)).toBe('The mitochondria is the *powerhouse* of the cell');
        expect(clozeAnswer(text, 1)).toBe('mitochondria');
    });
    test('makeCards expands each deletion into its own card', () => {
        const cards = makeCards({ text }, { now: T0 });
        expect(cards).toHaveLength(2);
        expect(cards.map(c => c.cloze)).toEqual([1, 2]);
        expect(question(cards[0])).toContain('[...]');
        expect(answer(cards[1])).toBe('powerhouse');
    });
});

describe('makeCards validation', () => {
    test('basic', () => {
        const [c] = makeCards({ front: ' Q ', back: ' A ', tags: 'a b' }, { now: T0 });
        expect(c).toMatchObject({ type: 'basic', front: 'Q', back: 'A', tags: ['a', 'b'], deckId: 'default' });
        expect(c.srs.state).toBe(State.new);
        expect(makeCards({ front: 'Q' })).toEqual([]);
    });
    test('mcq with index or answer text', () => {
        const [a] = makeCards({ front: 'Q', choices: ['x', 'y', 'z'], answer: 2 });
        expect(a.type).toBe('mcq');
        expect(answer(a)).toBe('z');
        const [b] = makeCards({ type: 'mcq', front: 'Q', choices: ['x', 'y'], answer: 'y' });
        expect(b.answer).toBe(1);
        expect(makeCards({ type: 'mcq', front: 'Q', choices: ['x'], answer: 0 })).toEqual([]);
        expect(makeCards({ type: 'mcq', front: 'Q', choices: ['x', 'y'], answer: 5 })).toEqual([]);
    });
});

describe('due queue ordering', () => {
    function card(id, srs, created = 0) {
        return { id, deckId: 'default', type: 'basic', front: id, back: id, created, srs };
    }
    const now = T0;
    const learningDue = card('learn', Object.assign(newSrs(now), { state: State.learning, due: now - MINUTE, stability: 1, difficulty: 5, lastReview: now - 2 * MINUTE }));
    const learningLater = card('learn-later', Object.assign(newSrs(now), { state: State.learning, due: now + 5 * MINUTE, stability: 1, difficulty: 5, lastReview: now }));
    const reviewOverdue = card('overdue', { state: State.review, due: now - 10 * DAY, stability: 5, difficulty: 5, lastReview: now - 15 * DAY, reps: 3, lapses: 0, step: 0 });
    const reviewJustDue = card('just-due', { state: State.review, due: now - 1000, stability: 5, difficulty: 5, lastReview: now - 5 * DAY, reps: 3, lapses: 0, step: 0 });
    const reviewFuture = card('future', { state: State.review, due: now + DAY, stability: 5, difficulty: 5, lastReview: now, reps: 3, lapses: 0, step: 0 });
    const new1 = card('new1', newSrs(now), 1);
    const new2 = card('new2', newSrs(now), 2);
    const all = [new2, reviewJustDue, reviewFuture, new1, reviewOverdue, learningLater, learningDue];

    test('learning first, then reviews by lowest retrievability, then new by creation', () => {
        expect(buildQueue(all, now).map(c => c.id)).toEqual(['learn', 'overdue', 'just-due', 'new1', 'new2']);
    });
    test('allowNew=false and newLimit', () => {
        expect(buildQueue(all, now, { allowNew: false }).map(c => c.id)).toEqual(['learn', 'overdue', 'just-due']);
        expect(buildQueue(all, now, { newLimit: 1 }).map(c => c.id)).toEqual(['learn', 'overdue', 'just-due', 'new1']);
    });
    test('learn-ahead when nothing else is due', () => {
        expect(buildQueue([learningLater, reviewFuture], now).map(c => c.id)).toEqual(['learn-later']);
        expect(buildQueue([learningLater], now, { learnAheadMs: MINUTE })).toEqual([]);
    });
    test('suspended and deck filter', () => {
        const s = Object.assign({}, reviewOverdue, { suspended: true });
        const other = Object.assign({}, reviewJustDue, { deckId: 'b' });
        expect(buildQueue([s, other], now, { allowNew: false }).map(c => c.id)).toEqual(['just-due']);
        expect(buildQueue([s, other], now, { deckId: 'default' })).toEqual([]);
    });
});

describe('stats', () => {
    test('due today, ride counts and retention from review logs', () => {
        const now = T0;
        const c1 = makeCards({ front: 'a', back: 'b' }, { now })[0];
        let c2 = makeCards({ front: 'c', back: 'd' }, { now })[0];
        c2 = Object.assign({}, c2, { srs: Object.assign({}, c2.srs, { state: State.review, due: now - 1 }) });
        const logs = [
            { cardId: 'x', rating: 3, state: State.review, review: now - 3 * DAY },
            { cardId: 'x', rating: 1, state: State.review, review: now - 2 * DAY },
            { cardId: 'y', rating: 3, state: State.new, review: now - 60 * 1000 },
            { cardId: 'y', rating: 4, state: State.review, review: now - 30 * 1000 },
        ];
        const s = stats([c1, c2], logs, now, { rideStart: now - 5 * 60 * 1000, newPerDay: 5 });
        expect(s.dueToday).toBe(1);
        expect(s.newAvailable).toBe(1);           // only one new card exists
        expect(s.reviewedThisRide).toBe(2);
        expect(s.rideCorrect).toBe(2);
        expect(s.retention).toBeCloseTo(2 / 3);
        expect(s.retentionSample).toBe(3);
    });
    test('retention is null with no mature reviews', () => {
        expect(stats([], [], T0).retention).toBeNull();
    });
});
