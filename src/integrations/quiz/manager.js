//
// <x-quiz-manager> — off-bike management on the Settings page:
// settings, decks, import (notes/CSV/TSV/Anki/JSON), AI generation, card browser, backup.
//

import { xf } from '../../functions.js';
import { h, injectStyles } from './dom.js';
import { quizStore, DEFAULT_DECK } from './store.js';
import { parseImport } from './parsers.js';
import { makeCards, question, answer, CardType, isNew } from './cards.js';
import { generateCards, isConfigured as aiConfigured } from './ai-generate.js';
import { SessionMode, NewCardPolicy } from './ride-state.js';
import { recognitionSupported, synthSupported } from './speech.js';
import * as settings from './settings.js';

function option(value, label, selected) {
    return h('option', { value, text: label, selected: value === selected });
}

function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function readFile(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsText(file);
    });
}

function describe(card) {
    const kind = { basic: 'Q/A', cloze: 'Cloze', mcq: 'Multiple choice' }[card.type] || card.type;
    return `${kind}: ${question(card)} → ${answer(card)}`;
}

class QuizManager extends HTMLElement {
    constructor() {
        super();
        this.decks = [];
        this.cards = [];
        this.pending = [];      // previewed cards awaiting approval
        this.editing = null;    // card id being edited
        this.filter = '';
        this.importDeck = DEFAULT_DECK.id;
        this.message = '';
        this.error = '';
    }
    connectedCallback() {
        injectStyles();
        this.classList.add('quiz', 'quiz-manager');
        this.sub = xf.sub('quiz:changed', () => this.load());
        this.load();
    }
    disconnectedCallback() {
        xf.unsub('quiz:changed', this.sub);
    }
    async load() {
        this.decks = await quizStore.listDecks();
        this.cards = await quizStore.listCards();
        this.render();
    }
    changed() {
        xf.dispatch('quiz:changed');
    }
    notify(message = '', error = '') {
        this.message = message;
        this.error = error;
        this.render();
    }

    // --- sections
    settingsSection() {
        const s = settings.load();
        const set = (key, parse = (x) => x) => (e) => {
            const v = e.target.type === 'checkbox' ? e.target.checked : parse(e.target.value);
            settings.save({ [key]: v });
            xf.dispatch('quiz:settings', settings.load());
        };
        return h('div', {},
            h('h3', { text: 'Quiz during rides' }),
            h('div', { class: 'q-grid' },
                h('label', {}, 'When to show cards',
                    h('select', { onchange: set('mode') },
                        option(SessionMode.always, 'Always', s.mode),
                        option(SessionMode.work, 'During work intervals', s.mode),
                        option(SessionMode.recovery, 'During recovery only', s.mode))),
                h('label', {}, 'New cards',
                    h('select', { onchange: set('newPolicy') },
                        option(NewCardPolicy.suggested, 'Moderate efforts / after intervals', s.newPolicy),
                        option(NewCardPolicy.anytime, 'Anytime', s.newPolicy),
                        option(NewCardPolicy.never, 'Never during a ride', s.newPolicy))),
                h('label', {}, 'New cards per day',
                    h('input', { type: 'number', min: '0', max: '500', value: String(s.newPerDay),
                                 onchange: set('newPerDay', x => Math.max(0, parseInt(x) || 0)) })),
                h('label', {}, 'Deck',
                    h('select', { onchange: set('deckId') },
                        option('', 'All decks', s.deckId),
                        this.decks.map(d => option(d.id, d.name, s.deckId)))),
                h('label', {}, 'Text size',
                    h('select', { onchange: set('textScale', parseFloat) },
                        [0.8, 1, 1.2, 1.4, 1.6].map(x => option(String(x), `${Math.round(x * 100)}%`, String(s.textScale))))),
                h('label', {}, 'Target retention',
                    h('select', { onchange: set('requestRetention', parseFloat) },
                        [0.8, 0.85, 0.9, 0.95].map(x => option(String(x), `${Math.round(x * 100)}%`, String(s.requestRetention))))),
                h('label', {}, 'Hands-free: reveal answer after (s)',
                    h('input', { type: 'number', min: '2', max: '60', value: String(s.revealSeconds),
                                 onchange: set('revealSeconds', x => Math.min(60, Math.max(2, parseInt(x) || 8))) })),
                h('label', {}, '"After interval" window (min)',
                    h('input', { type: 'number', min: '0', max: '20', value: String(s.afterIntervalMin),
                                 onchange: set('afterIntervalMin', x => Math.max(0, parseFloat(x) || 0)) })),
                h('label', { class: 'q-check' },
                    h('input', { type: 'checkbox', checked: !!s.voiceGrading, onchange: set('voiceGrading') }),
                    'Hands-free: grade by voice ("again / hard / good / easy")')),
            h('p', { class: 'q-note q-muted', text:
                'Some studies link moderate exercise to better memory and learning, but the evidence on timing ' +
                'and intensity is still preliminary. The default introduces new cards at moderate efforts or ' +
                'right after an interval and keeps reviews for steady riding; change it to whatever works for you.' }),
            h('p', { class: 'q-note q-muted', text:
                `Speech: read-aloud ${synthSupported() ? 'available' : 'not supported in this browser'}; ` +
                `voice grading ${recognitionSupported() ? 'available (needs mic permission; on iPad requires Siri/Dictation enabled)' : 'not supported in this browser, use the buttons'}.` }));
    }

    decksSection() {
        const name = h('input', { type: 'text', placeholder: 'New deck name' });
        return h('div', {},
            h('h3', { text: 'Decks' }),
            h('div', { class: 'q-list' }, this.decks.map(d => {
                const count = this.cards.filter(c => c.deckId === d.id).length;
                return h('div', { class: 'q-item' },
                    h('span', { class: 'q-item-text', text: `${d.name} (${count} cards)` }),
                    d.id === DEFAULT_DECK.id ? null :
                        h('button', { class: 'q-btn', text: 'Delete', onclick: async () => {
                            if(!confirm(`Delete deck "${d.name}" and its ${count} cards?`)) return;
                            await quizStore.deleteDeck(d.id);
                            this.changed();
                        } }));
            })),
            h('div', { class: 'q-row', style: { marginTop: '8px' } }, name,
                h('button', { class: 'q-btn', text: 'Add deck', onclick: async () => {
                    if(!name.value.trim()) return;
                    await quizStore.saveDeck({ name: name.value.trim() });
                    this.changed();
                } })));
    }

    importSection() {
        const text = h('textarea', { placeholder:
            'Paste notes or cards. Supported:\n' +
            'Q: question / A: answer\n' +
            'term :: definition\n' +
            'The {{c1::mitochondria}} is the powerhouse of the cell\n' +
            'Q: question  then  - [ ] wrong / - [x] right   (multiple choice)\n' +
            'CSV / TSV: front,back[,tags]   or an Anki "Notes in Plain Text" export' });
        text.value = this.draft || '';
        text.addEventListener('input', () => { this.draft = text.value; });
        const format = h('select', {},
            option('auto', 'Detect format', 'auto'), option('notes', 'Notes / Markdown', ''),
            option('csv', 'CSV', ''), option('tsv', 'TSV', ''), option('anki', 'Anki plain text', ''));
        const headings = h('input', { type: 'checkbox' });
        const file = h('input', { type: 'file', accept: '.txt,.csv,.tsv,.md,.markdown,.json,text/*',
            onchange: async (e) => {
                const f = e.target.files[0];
                if(!f) return;
                this.draft = await readFile(f);
                this.render();
            } });
        const deck = h('select', { onchange: e => { this.importDeck = e.target.value; } },
            this.decks.map(d => option(d.id, d.name, this.importDeck)));

        const doPreview = () => {
            try {
                const raws = parseImport(text.value, format.value, { headings: headings.checked });
                this.pending = raws.flatMap(r => makeCards(r, { deckId: this.importDeck }));
                this.notify(this.pending.length ? `${this.pending.length} cards ready to review below.` : '',
                            this.pending.length ? '' : 'No cards found. Check the format hints.');
            } catch(err) {
                this.notify('', `Import failed: ${err.message}`);
            }
        };
        const doGenerate = async () => {
            if(!text.value.trim()) return this.notify('', 'Paste some notes first.');
            this.notify('Generating cards with Claude…');
            try {
                this.pending = await generateCards(text.value, { deckId: this.importDeck });
                this.notify(this.pending.length ? `Claude suggested ${this.pending.length} cards. Review and save below.` : '',
                            this.pending.length ? '' : 'Claude returned no usable cards.');
            } catch(err) {
                this.notify('', `AI generation failed: ${err.message}`);
            }
        };
        const ai = aiConfigured();
        return h('div', {},
            h('h3', { text: 'Add cards' }),
            text,
            h('div', { class: 'q-row', style: { marginTop: '8px' } },
                h('label', {}, 'Format', format),
                h('label', {}, 'Into deck', deck),
                h('label', { class: 'q-check' }, headings, 'Markdown headings become cards'),
                h('label', {}, 'Or load a file', file)),
            h('div', { class: 'q-row', style: { marginTop: '8px' } },
                h('button', { class: 'q-btn', text: 'Preview import', onclick: doPreview }),
                h('button', { class: 'q-btn', text: 'Generate cards from notes (AI)', disabled: !ai, onclick: doGenerate }),
                ai ? null : h('span', { class: 'q-note q-muted', text: 'Add an Anthropic key in AI settings to enable.' })),
            this.message ? h('p', { text: this.message }) : null,
            this.error ? h('p', { class: 'q-error', text: this.error }) : null,
            this.pendingList());
    }

    pendingList() {
        if(!this.pending.length) return null;
        const checks = this.pending.map(() => h('input', { type: 'checkbox', checked: true }));
        return h('div', {},
            h('div', { class: 'q-list' }, this.pending.map((c, i) =>
                h('label', { class: 'q-item q-check' }, checks[i], h('span', { class: 'q-item-text', text: describe(c) })))),
            h('div', { class: 'q-row', style: { marginTop: '8px' } },
                h('button', { class: 'q-btn', text: 'Save selected', onclick: async () => {
                    const chosen = this.pending.filter((_, i) => checks[i].checked);
                    const saved = await quizStore.addCards(chosen, this.importDeck);
                    this.pending = [];
                    this.draft = '';
                    this.message = `Saved ${saved.length} cards.`;
                    this.error = '';
                    this.changed();
                } }),
                h('button', { class: 'q-btn', text: 'Discard', onclick: () => { this.pending = []; this.notify(); } })));
    }

    editor(card) {
        const type = h('select', {},
            option('basic', 'Question / answer', card.type), option('cloze', 'Cloze', card.type),
            option('mcq', 'Multiple choice', card.type));
        const front = h('textarea', { style: { minHeight: '64px' } });
        front.value = card.type === CardType.cloze ? card.text : (card.front || '');
        const back = h('textarea', { style: { minHeight: '64px' } });
        back.value = card.back || '';
        const choices = h('textarea', { style: { minHeight: '64px' }, placeholder: 'One choice per line; start the correct one with *' });
        choices.value = (card.choices || []).map((c, i) => (i === card.answer ? '*' : '') + c).join('\n');
        const save = async () => {
            const t = type.value;
            let raw;
            if(t === 'cloze') raw = { type: t, text: front.value, back: back.value, cloze: card.type === 'cloze' ? card.cloze : undefined };
            else if(t === 'mcq') {
                const lines = choices.value.split('\n').map(x => x.trim()).filter(Boolean);
                raw = { type: t, front: front.value, back: back.value,
                        choices: lines.map(l => l.replace(/^\*/, '').trim()),
                        answer: Math.max(0, lines.findIndex(l => l.startsWith('*'))) };
            } else raw = { type: t, front: front.value, back: back.value };
            // keep id + schedule unless the card type changed
            const keep = t === card.type ? { id: card.id, srs: card.srs, created: card.created } : {};
            const made = makeCards(Object.assign(raw, keep, { tags: card.tags }), { deckId: card.deckId });
            if(!made.length) return alert('Card is incomplete (cloze needs {{c1::...}}, multiple choice needs 2+ choices and one marked with *).');
            if(card.id && (t !== card.type || made[0].id !== card.id)) await quizStore.deleteCard(card.id);
            for(const c of made) await quizStore.updateCard(c);
            this.editing = null;
            this.changed();
        };
        return h('div', { class: 'q-item', style: { flexDirection: 'column', alignItems: 'stretch' } },
            h('label', {}, 'Type', type),
            h('label', {}, 'Front (or cloze text)', front),
            h('label', {}, 'Back / explanation', back),
            h('label', {}, 'Choices (multiple choice only)', choices),
            h('div', { class: 'q-row' },
                h('button', { class: 'q-btn', text: 'Save', onclick: save }),
                h('button', { class: 'q-btn', text: 'Cancel', onclick: () => { this.editing = null; this.render(); } })));
    }

    browserSection() {
        const search = h('input', { type: 'text', placeholder: 'Search cards', value: this.filter });
        search.addEventListener('change', () => { this.filter = search.value; this.render(); });
        const f = this.filter.toLowerCase();
        const list = this.cards
              .filter(c => !f || describe(c).toLowerCase().includes(f))
              .sort((a, b) => b.created - a.created)
              .slice(0, 200);
        return h('div', {},
            h('h3', { text: `Cards (${this.cards.length})` }),
            h('div', { class: 'q-row' }, search,
                h('button', { class: 'q-btn', text: 'New card', onclick: async () => {
                    this.editing = 'new';
                    this.render();
                } })),
            this.editing === 'new' ? this.editor({ id: null, type: 'basic', deckId: this.importDeck, tags: [] }) : null,
            h('div', { class: 'q-list', style: { marginTop: '8px' } }, list.map(c => this.editing === c.id ? this.editor(c) :
                h('div', { class: 'q-item' },
                    h('span', { class: 'q-item-text' }, describe(c),
                        h('div', { class: 'q-note q-muted', text: isNew(c) ? 'new' :
                            `${c.srs.state} · due ${new Date(c.srs.due).toLocaleDateString()} · lapses ${c.srs.lapses}` })),
                    h('button', { class: 'q-btn', text: 'Edit', onclick: () => { this.editing = c.id; this.render(); } }),
                    h('button', { class: 'q-btn', text: 'Delete', onclick: async () => {
                        if(!confirm('Delete this card?')) return;
                        await quizStore.deleteCard(c.id);
                        this.changed();
                    } })))),
            this.cards.length > list.length ? h('p', { class: 'q-note q-muted', text: 'Showing 200 most recent; search to find others.' }) : null);
    }

    backupSection() {
        const file = h('input', { type: 'file', accept: '.json,application/json', onchange: async (e) => {
            const f = e.target.files[0];
            if(!f) return;
            try {
                const res = await quizStore.importJSON(JSON.parse(await readFile(f)), { merge: true });
                this.message = `Restored ${res.cards} cards, ${res.reviews} reviews.`;
                this.error = '';
                this.changed();
            } catch(err) {
                this.notify('', `Restore failed: ${err.message}`);
            }
        } });
        return h('div', {},
            h('h3', { text: 'Backup' }),
            h('div', { class: 'q-row' },
                h('button', { class: 'q-btn', text: 'Export JSON backup', onclick: async () => {
                    const data = await quizStore.exportJSON();
                    download(`flux-quiz-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
                } }),
                h('label', {}, 'Restore / merge from JSON', file)));
    }

    render() {
        this.replaceChildren(
            this.settingsSection(), this.decksSection(), this.importSection(),
            this.browserSection(), this.backupSection());
    }
}

//
// <x-quiz-ride-summary> — post-ride (Ride report) line: cards reviewed / recalled
//
class QuizRideSummary extends HTMLElement {
    connectedCallback() {
        injectStyles();
        this.classList.add('quiz', 'quiz-summary');
        this.onState = this.onState.bind(this);
        this.sub = xf.sub('quiz:state', this.onState);
        this.sub2 = xf.sub('quiz:ride-summary', () => this.render());
        this.render();
    }
    disconnectedCallback() {
        xf.unsub('quiz:state', this.sub);
        xf.unsub('quiz:ride-summary', this.sub2);
    }
    onState(state) {
        this.state = state;
        this.render();
    }
    render() {
        let last = null;
        try { last = JSON.parse(localStorage.getItem('quiz:last-ride') || 'null'); } catch(e) { /* ignore */ }
        const st = this.state && this.state.stats;
        const live = this.state && this.state.riding && st;
        const reviewed = live ? st.reviewedThisRide : (last ? last.reviewed : 0);
        const correct = live ? st.rideCorrect : (last ? last.correct : 0);
        if(!st && !last) { this.replaceChildren(); return; }
        this.replaceChildren(
            h('span', {}, 'Cards reviewed ', h('b', { text: String(reviewed) })),
            reviewed ? h('span', {}, 'Recalled ', h('b', { text: `${Math.round(100 * correct / reviewed)}%` })) : null,
            st ? h('span', { class: 'q-muted', text: `Due today ${st.dueToday}` }) : null);
    }
}

customElements.define('x-quiz-manager', QuizManager);
customElements.define('x-quiz-ride-summary', QuizRideSummary);

export { QuizManager, QuizRideSummary };
