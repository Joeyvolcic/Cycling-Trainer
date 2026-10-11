//
// <x-quiz-panel> — in-ride review UI. Large text, big targets, tap-to-reveal,
// optional hands-free (speech) mode.
//

import { xf } from '../../functions.js';
import { h, injectStyles } from './dom.js';
import { session } from './session.js';
import { question, answer, CardType, renderClozeBack } from './cards.js';
import { preview, formatInterval, Rating } from './fsrs.js';
import { Zone, SessionMode } from './ride-state.js';
import * as settings from './settings.js';
import * as speech from './speech.js';

const zoneLabel = {
    [Zone.idle]: 'Not riding', [Zone.unknown]: 'Riding', [Zone.recovery]: 'Recovery',
    [Zone.endurance]: 'Endurance', [Zone.tempo]: 'Tempo', [Zone.work]: 'Work interval',
};
const gradeLabel = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };
const letters = 'ABCDEFGH';

class QuizPanel extends HTMLElement {
    constructor() {
        super();
        this.state = null;
        this.cardId = null;
        this.phase = 'question';
        this.picked = null;
        this.override = false;
        this.overrideZone = null;
        this.handsFreeToken = 0;
        this.timer = null;
    }
    connectedCallback() {
        injectStyles();
        this.classList.add('quiz', 'quiz-panel');
        this.onState = this.onState.bind(this);
        this.sub = xf.sub('quiz:state', this.onState);
        this.onState(session.state());
    }
    disconnectedCallback() {
        xf.unsub('quiz:state', this.sub);
        this.stopHandsFree();
    }

    onState(state) {
        const prevZone = this.state && this.state.zone;
        this.state = state;
        if(this.override && state.zone !== this.overrideZone) this.override = false;
        const id = state.current ? state.current.id : null;
        if(id !== this.cardId) {
            this.cardId = id;
            this.phase = 'question';
            this.picked = null;
            this.render();
            this.maybeHandsFree();
            return;
        }
        if(prevZone !== state.zone) this.render();
        else this.renderStatus();
    }

    visible() {
        return this.state && (this.state.show || this.override);
    }

    // --- actions
    reveal(pickedIndex = null) {
        if(this.phase === 'answer') return;
        this.phase = 'answer';
        this.picked = pickedIndex;
        this.stopHandsFree();
        this.render();
        const card = this.state && this.state.current;
        if(card && settings.load().handsFree) this.afterReveal(card, this.handsFreeToken);
    }
    async rate(r) {
        this.stopHandsFree(false);
        await session.rate(r);
    }
    skip() {
        this.stopHandsFree(false);
        session.skip();
    }
    toggleHandsFree() {
        const s = settings.save({ handsFree: !settings.load().handsFree });
        if(s.handsFree) {
            speech.unlock(); // iOS: must happen inside the tap
            this.maybeHandsFree();
        } else {
            this.stopHandsFree();
        }
        this.render();
    }
    stopHandsFree(cancelSpeech = true) {
        this.handsFreeToken++;
        clearTimeout(this.timer);
        clearInterval(this.progressTimer);
        if(cancelSpeech) speech.cancel();
    }

    // --- hands-free loop: speak Q -> wait N s -> reveal + speak A -> listen / wait for tap
    async maybeHandsFree() {
        const s = settings.load();
        this.stopHandsFree();
        if(!s.handsFree || !this.state || !this.state.current || !this.visible()) return;
        const token = this.handsFreeToken;
        const alive = () => token === this.handsFreeToken;
        const card = this.state.current;

        if(this.phase === 'answer') return this.afterReveal(card, token);
        await speech.speak(this.spokenQuestion(card), { rate: s.speechRate });
        if(!alive()) return;
        await this.countdown(s.revealSeconds * 1000, token);
        if(!alive()) return;
        this.reveal(); // reveal() continues with afterReveal()
    }
    async afterReveal(card, token) {
        const s = settings.load();
        const alive = () => token === this.handsFreeToken;
        if(!alive()) return;
        await speech.speak(`Answer: ${this.spokenAnswer(card)}`, { rate: s.speechRate });
        if(!alive() || !s.voiceGrading || !speech.recognitionSupported()) return;
        for(let tries = 0; tries < 2 && alive(); tries++) {
            const r = await speech.listen({ timeoutMs: 7000 });
            if(!alive()) return;
            if(r === 'skip') return this.skip();
            if(r === 'repeat') { await speech.speak(this.spokenAnswer(card), { rate: s.speechRate }); continue; }
            if(typeof r === 'number') return this.rate(r);
        }
    }
    countdown(ms, token) {
        return new Promise(resolve => {
            const bar = this.querySelector('.q-progress > div');
            const t0 = Date.now();
            clearInterval(this.progressTimer);
            this.progressTimer = setInterval(() => {
                const x = Math.min(1, (Date.now() - t0) / ms);
                if(bar) bar.style.width = `${x * 100}%`;
                if(x >= 1 || token !== this.handsFreeToken) clearInterval(this.progressTimer);
            }, 100);
            this.timer = setTimeout(resolve, ms);
        });
    }
    spokenQuestion(card) {
        const q = question(card);
        if(card.type !== CardType.mcq) return q;
        return `${q}. ` + card.choices.map((c, i) => `${letters[i]}: ${c}`).join('. ');
    }
    spokenAnswer(card) {
        if(card.type === CardType.mcq) return `${letters[card.answer]}, ${answer(card)}`;
        return answer(card);
    }

    // --- rendering
    statusEl() {
        const st = this.state ? this.state.stats : null;
        const zone = this.state ? this.state.zone : Zone.idle;
        let zoneText = zoneLabel[zone] || zone;
        if(this.state && this.state.afterInterval) zoneText += ' · after interval';
        const retention = st && st.retention !== null ? `${Math.round(st.retention * 100)}%` : '–';
        return h('div', { class: 'q-status' },
            h('span', { class: 'q-zone', 'data-zone': zone, text: zoneText }),
            st ? h('span', { class: 'q-muted' },
                   `Due ${st.dueToday + st.newAvailable} · This ride ${st.reviewedThisRide} · Retention ${retention}`) : null);
    }
    renderStatus() {
        const old = this.querySelector('.q-status');
        if(old) old.replaceWith(this.statusEl());
    }
    toolbar() {
        const s = settings.load();
        return h('div', { class: 'q-toolbar' },
            h('button', { class: 'q-btn', onclick: () => this.toggleHandsFree(),
                          'aria-pressed': String(!!s.handsFree),
                          text: `Hands-free: ${s.handsFree ? 'on' : 'off'}` }),
            this.state && this.state.current ?
                h('button', { class: 'q-btn', onclick: () => this.skip(), text: 'Skip' }) : null);
    }
    render() {
        const s = settings.load();
        this.style.setProperty('--q-scale', s.textScale || 1);
        this.replaceChildren(this.statusEl(), this.body(s), this.toolbar());
    }
    body(s) {
        const state = this.state;
        if(!state || !state.loaded) return h('div', { class: 'q-msg q-muted', text: 'Loading cards…' });
        if(!this.visible()) {
            const why = s.mode === SessionMode.recovery ? 'Quiz resumes in recovery.' :
                        s.mode === SessionMode.work ? 'Quiz resumes in the next work interval.' : '';
            return h('div', { class: 'q-card' },
                h('div', { class: 'q-msg', text: `Focus on the ride. ${why}` }),
                h('button', { class: 'q-btn q-reveal', text: 'Show cards anyway',
                              onclick: () => { this.override = true; this.overrideZone = state.zone; this.render(); this.maybeHandsFree(); } }));
        }
        const card = state.current;
        if(!card) {
            const msg = state.stats && state.stats.total === 0 ?
                  'No cards yet. Add or import cards in Settings > Quiz.' :
                  (!state.allowNew && state.stats && state.stats.newAvailable > 0) ?
                  'Reviews done. New cards are held for moderate efforts or right after intervals.' :
                  'All caught up. Nothing due right now.';
            return h('div', { class: 'q-card' }, h('div', { class: 'q-msg', text: msg }));
        }

        const children = [h('div', { class: 'q-question', text: question(card) })];
        if(s.handsFree && this.phase === 'question') {
            children.push(h('div', { class: 'q-progress' }, h('div')));
        }

        if(card.type === CardType.mcq) {
            children.push(h('div', { class: 'q-choices' }, card.choices.map((c, i) => {
                let cls = 'q-btn q-choice';
                if(this.phase === 'answer' && i === card.answer) cls += ' q-correct';
                if(this.phase === 'answer' && i === this.picked && i !== card.answer) cls += ' q-picked-wrong';
                return h('button', { class: cls, text: `${letters[i]}. ${c}`,
                                     disabled: this.phase === 'answer',
                                     onclick: () => this.reveal(i) });
            })));
            if(this.phase === 'answer' && card.back) {
                children.push(h('div', { class: 'q-answer', text: card.back }));
            }
            if(this.phase === 'question') {
                children.push(h('button', { class: 'q-btn q-reveal', text: 'Show answer', onclick: () => this.reveal() }));
            }
        } else if(this.phase === 'question') {
            children.push(h('button', { class: 'q-btn q-reveal', text: 'Show answer', onclick: () => this.reveal() }));
        } else {
            const text = card.type === CardType.cloze ? renderClozeBack(card.text, card.cloze, a => `[${a}]`) : answer(card);
            children.push(h('div', { class: 'q-answer', text }));
            if(card.type === CardType.cloze && card.back) children.push(h('div', { class: 'q-muted', text: card.back }));
        }

        const cardEl = h('div', { class: 'q-card' }, children);
        if(this.phase === 'question' && card.type !== CardType.mcq) {
            // whole card is a tap target for reveal (sweaty-finger friendly)
            cardEl.addEventListener('click', (e) => { if(e.target === cardEl || e.target.classList.contains('q-question')) this.reveal(); });
        }
        if(this.phase !== 'answer') return cardEl;

        const ivl = preview(card.srs, Date.now());
        let suggested = Rating.good;
        if(card.type === CardType.mcq && this.picked !== null) {
            suggested = this.picked === card.answer ? Rating.good : Rating.again;
        }
        const grades = h('div', { class: 'q-grades' }, [1, 2, 3, 4].map(r =>
            h('button', { class: `q-btn q-grade${(card.type === CardType.mcq && this.picked !== null && r === suggested) ? ' q-suggested' : ''}`,
                          'data-r': String(r), onclick: () => this.rate(r) },
              gradeLabel[r], h('small', { text: formatInterval(ivl[r]) }))));
        const wrap = document.createDocumentFragment();
        wrap.append(cardEl, grades);
        const holder = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', flex: '1' } });
        holder.append(wrap);
        return holder;
    }
}

customElements.define('x-quiz-panel', QuizPanel);

export { QuizPanel };
