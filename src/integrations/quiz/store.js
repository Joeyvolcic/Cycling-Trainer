//
// Quiz persistence — a separate IndexedDB database ('flux-quiz') so the app's
// shared 'store' DB version/upgrade path (src/db.js) is untouched.
//
// stores: decks {id, name, created}, cards {id, deckId, ...}, reviews {id, cardId, rating, review, ...}
//

import { makeCards, uid } from './cards.js';
import { review as fsrsReview } from './fsrs.js';

const DB_NAME = 'flux-quiz';
const DB_VERSION = 1;
const STORES = ['decks', 'cards', 'reviews'];
const DEFAULT_DECK = { id: 'default', name: 'My cards' };

function promisify(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function QuizStore({ name = DB_NAME, factory = null } = {}) {
    let dbp = null;

    function open() {
        if(dbp) return dbp;
        const idbf = factory || (typeof indexedDB !== 'undefined' ? indexedDB : window.indexedDB);
        const req = idbf.open(name, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            STORES.forEach(s => {
                if(!db.objectStoreNames.contains(s)) {
                    const store = db.createObjectStore(s, { keyPath: 'id' });
                    if(s === 'cards') store.createIndex('deckId', 'deckId');
                    if(s === 'reviews') store.createIndex('review', 'review');
                }
            });
        };
        dbp = promisify(req).then(async db => {
            await ensureDefaultDeck(db);
            return db;
        });
        return dbp;
    }

    function ensureDefaultDeck(db) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction('decks', 'readwrite');
            const store = tx.objectStore('decks');
            const req = store.get(DEFAULT_DECK.id);
            req.onsuccess = () => {
                if(!req.result) store.put(Object.assign({ created: Date.now() }, DEFAULT_DECK));
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function run(storeName, mode, fn) {
        const db = await open();
        const tx = db.transaction(storeName, mode);
        const done = new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        const result = await fn(tx.objectStore(storeName));
        await done;
        return result;
    }

    const getAll = (s) => run(s, 'readonly', st => promisify(st.getAll()));
    const get    = (s, id) => run(s, 'readonly', st => promisify(st.get(id)));
    const put    = (s, item) => run(s, 'readwrite', st => promisify(st.put(item)));
    const putMany = (s, items) => run(s, 'readwrite', st => Promise.all(items.map(i => promisify(st.put(i)))));
    const del    = (s, id) => run(s, 'readwrite', st => promisify(st.delete(id)));

    // Decks
    const listDecks = () => getAll('decks');
    async function saveDeck(deck) {
        const d = Object.assign({ id: uid(), created: Date.now() }, deck);
        await put('decks', d);
        return d;
    }
    async function deleteDeck(id) {
        if(id === DEFAULT_DECK.id) throw new Error('quiz: cannot delete the default deck');
        const cards = (await listCards()).filter(c => c.deckId === id);
        await run('cards', 'readwrite', st => Promise.all(cards.map(c => promisify(st.delete(c.id)))));
        await del('decks', id);
    }

    // Cards
    async function listCards(deckId = null) {
        const all = await getAll('cards');
        return deckId ? all.filter(c => c.deckId === deckId) : all;
    }
    const getCard = (id) => get('cards', id);
    async function addCards(raws = [], deckId = DEFAULT_DECK.id) {
        const now = Date.now();
        const cards = raws.flatMap((r, i) => makeCards(r, { deckId, now: now + i }));
        if(cards.length) await putMany('cards', cards);
        return cards;
    }
    async function updateCard(card) {
        const c = Object.assign({}, card, { updated: Date.now() });
        await put('cards', c);
        return c;
    }
    const deleteCard = (id) => del('cards', id);

    // Reviews
    async function reviewCard(card, rating, now = Date.now(), params = {}) {
        const { srs, log } = fsrsReview(card.srs, rating, now, params);
        const updated = Object.assign({}, card, { srs });
        const entry = Object.assign({ id: uid(), cardId: card.id, deckId: card.deckId }, log);
        await put('cards', updated);
        await put('reviews', entry);
        return { card: updated, log: entry };
    }
    const listReviews = () => getAll('reviews');

    // Backup
    async function exportJSON() {
        return {
            app: 'flux-quiz', version: 1, exportedAt: new Date().toISOString(),
            decks: await listDecks(), cards: await listCards(), reviews: await listReviews(),
        };
    }
    // merge=true keeps existing data and overwrites by id; merge=false clears first
    async function importJSON(data, { merge = true } = {}) {
        if(!data || data.app !== 'flux-quiz' || !Array.isArray(data.cards)) {
            throw new Error('quiz: not a flux-quiz backup');
        }
        if(!merge) {
            for(const s of STORES) await run(s, 'readwrite', st => promisify(st.clear()));
            await ensureDefaultDeck(await open());
        }
        if(data.decks && data.decks.length) await putMany('decks', data.decks);
        const cards = data.cards.flatMap(c => c.id && c.srs ? [c] : makeCards(c, { deckId: c.deckId }));
        if(cards.length) await putMany('cards', cards);
        if(data.reviews && data.reviews.length) await putMany('reviews', data.reviews);
        return { decks: (data.decks || []).length, cards: cards.length, reviews: (data.reviews || []).length };
    }

    return Object.freeze({
        open, listDecks, saveDeck, deleteDeck,
        listCards, getCard, addCards, updateCard, deleteCard,
        reviewCard, listReviews, exportJSON, importJSON,
        DEFAULT_DECK,
    });
}

const quizStore = QuizStore();

export { QuizStore, quizStore, DEFAULT_DECK };
