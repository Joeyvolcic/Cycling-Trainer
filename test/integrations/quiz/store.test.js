/**
 * @jest-environment jsdom
 */

import indexedDB from 'fake-indexeddb';
import { QuizStore } from '../../../src/integrations/quiz/store.js';
import { parseResponse, generateCards } from '../../../src/integrations/quiz/ai-generate.js';
import { Rating, State } from '../../../src/integrations/quiz/fsrs.js';

describe('QuizStore (IndexedDB)', () => {
    const store = QuizStore({ name: 'quiz-test', factory: indexedDB });

    test('default deck exists', async () => {
        const decks = await store.listDecks();
        expect(decks.map(d => d.id)).toContain('default');
    });

    test('add, edit, review, delete cards', async () => {
        const deck = await store.saveDeck({ name: 'Bio' });
        const added = await store.addCards([
            { front: 'Q1', back: 'A1' },
            { text: '{{c1::ATP}} and {{c2::ADP}}' },
            { front: 'bad' },
        ], deck.id);
        expect(added).toHaveLength(3);
        expect((await store.listCards(deck.id))).toHaveLength(3);

        const basic = added.find(c => c.type === 'basic');
        await store.updateCard(Object.assign({}, basic, { back: 'A1 edited' }));
        expect((await store.getCard(basic.id)).back).toBe('A1 edited');

        const { card, log } = await store.reviewCard(basic, Rating.good, Date.now());
        expect(card.srs.state).toBe(State.learning);
        expect(log.cardId).toBe(basic.id);
        expect(await store.listReviews()).toHaveLength(1);

        await store.deleteCard(basic.id);
        expect(await store.listCards(deck.id)).toHaveLength(2);

        await store.deleteDeck(deck.id);
        expect(await store.listCards(deck.id)).toHaveLength(0);
        await expect(store.deleteDeck('default')).rejects.toThrow();
    });

    test('JSON export / import round trip', async () => {
        await store.addCards([{ front: 'x', back: 'y' }]);
        const backup = await store.exportJSON();
        expect(backup.app).toBe('flux-quiz');
        const other = QuizStore({ name: 'quiz-test-2', factory: indexedDB });
        const res = await other.importJSON(JSON.parse(JSON.stringify(backup)), { merge: false });
        expect(res.cards).toBe(backup.cards.length);
        expect((await other.listCards()).map(c => c.id).sort()).toEqual(backup.cards.map(c => c.id).sort());
        await expect(other.importJSON({ foo: 1 })).rejects.toThrow();
    });
});

describe('AI card generation', () => {
    test('parseResponse accepts objects, arrays and JSON in text', () => {
        expect(parseResponse({ cards: [{ front: 'a', back: 'b' }] })).toHaveLength(1);
        expect(parseResponse([{ front: 'a', back: 'b' }])).toHaveLength(1);
        expect(parseResponse('Sure! {"cards":[{"front":"a","back":"b"}]}')).toHaveLength(1);
        expect(parseResponse('nope')).toEqual([]);
    });

    test('generateCards validates output and requires configuration', async () => {
        const client = {
            isConfigured: () => true,
            complete: jest.fn(async () => ({ cards: [
                { type: 'basic', front: 'Q', back: 'A' },
                { type: 'cloze', text: 'The {{c1::sun}} is a star' },
                { type: 'mcq', front: 'Pick', choices: ['a', 'b', 'c'], answer: 1 },
                { type: 'mcq', front: 'broken', choices: ['a'], answer: 0 },
            ] })),
        };
        const cards = await generateCards('notes here', { client, deckId: 'd1' });
        expect(cards.map(c => c.type)).toEqual(['basic', 'cloze', 'mcq']);
        expect(cards.every(c => c.deckId === 'd1')).toBe(true);
        expect(client.complete.mock.calls[0][0]).toMatchObject({ json: true });

        await expect(generateCards('x', { client: { isConfigured: () => false } })).rejects.toThrow();
    });
});
