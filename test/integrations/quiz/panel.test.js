/**
 * @jest-environment jsdom
 */

import indexedDB from 'fake-indexeddb';
window.indexedDB = indexedDB;

import { xf } from '../../../src/functions.js';
import { makeCards } from '../../../src/integrations/quiz/cards.js';
import { Zone } from '../../../src/integrations/quiz/ride-state.js';
import '../../../src/integrations/quiz/panel.js';
import '../../../src/integrations/quiz/manager.js';

global.console = { log: jest.fn(), error: console.error, warn: jest.fn() };

const stats = { total: 2, dueToday: 1, newAvailable: 1, reviewedThisRide: 0, rideCorrect: 0, retention: null };

function state(current, extra = {}) {
    return Object.assign({ loaded: true, zone: Zone.endurance, show: true, allowNew: true,
                           afterInterval: false, current, stats, riding: true, queueSize: 1 }, extra);
}

describe('<x-quiz-panel>', () => {
    let el;
    beforeEach(() => {
        el = document.createElement('x-quiz-panel');
        document.body.append(el);
    });
    afterEach(() => el.remove());

    test('tap-to-reveal basic card shows four grade buttons', () => {
        const [card] = makeCards({ front: 'Capital of France?', back: 'Paris' });
        xf.dispatch('quiz:state', state(card));
        expect(el.querySelector('.q-question').textContent).toBe('Capital of France?');
        el.querySelector('.q-reveal').click();
        expect(el.querySelector('.q-answer').textContent).toBe('Paris');
        const grades = el.querySelectorAll('.q-grade');
        expect(Array.from(grades).map(b => b.firstChild.textContent)).toEqual(['Again', 'Hard', 'Good', 'Easy']);
    });

    test('multiple choice: picking a wrong option highlights and suggests Again', () => {
        const [card] = makeCards({ front: 'Pick', choices: ['a', 'b'], answer: 0 });
        xf.dispatch('quiz:state', state(card));
        el.querySelectorAll('.q-choice')[1].click();
        expect(el.querySelector('.q-picked-wrong')).not.toBeNull();
        expect(el.querySelector('.q-correct').textContent).toBe('A. a');
        expect(el.querySelector('.q-suggested').dataset.r).toBe('1');
    });

    test('gated out: shows pause message with override', () => {
        const [card] = makeCards({ front: 'Q', back: 'A' });
        xf.dispatch('quiz:state', state(card, { show: false, zone: Zone.work }));
        expect(el.querySelector('.q-question')).toBeNull();
        el.querySelector('.q-reveal').click(); // "Show cards anyway"
        expect(el.querySelector('.q-question').textContent).toBe('Q');
    });

    test('empty state', () => {
        xf.dispatch('quiz:state', state(null, { stats: Object.assign({}, stats, { total: 0 }) }));
        expect(el.textContent).toContain('No cards yet');
    });
});

describe('<x-quiz-manager>', () => {
    test('renders sections', async () => {
        const el = document.createElement('x-quiz-manager');
        document.body.append(el);
        await new Promise(r => setTimeout(r, 50));
        const headings = Array.from(el.querySelectorAll('h3')).map(x => x.textContent);
        expect(headings).toEqual(expect.arrayContaining(['Quiz during rides', 'Decks', 'Add cards', 'Backup']));
        el.remove();
    });
});
