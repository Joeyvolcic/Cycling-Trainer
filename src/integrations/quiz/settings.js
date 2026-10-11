//
// Quiz settings — localStorage 'quiz:settings' (per contract: <name>:* keys)
//

import { SessionMode, NewCardPolicy } from './ride-state.js';

const KEY = 'quiz:settings';

const defaults = Object.freeze({
    mode: SessionMode.always,            // always | work | recovery
    newPolicy: NewCardPolicy.suggested,  // anytime | suggested | never
    newPerDay: 20,
    deckId: '',                          // '' = all decks
    handsFree: false,
    revealSeconds: 8,                    // hands-free: seconds before the answer is revealed
    voiceGrading: true,                  // hands-free: listen for "again/hard/good/easy" where supported
    speechRate: 1,
    textScale: 1,                        // 0.8 .. 1.6
    afterIntervalMin: 3,                 // "right after an interval" window for new cards
    requestRetention: 0.9,
});

function load() {
    try {
        const raw = localStorage.getItem(KEY);
        return Object.assign({}, defaults, raw ? JSON.parse(raw) : {});
    } catch(e) {
        return Object.assign({}, defaults);
    }
}

function save(patch = {}) {
    const next = Object.assign(load(), patch);
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch(e) { /* private mode */ }
    return next;
}

export { KEY, defaults, load, save };
