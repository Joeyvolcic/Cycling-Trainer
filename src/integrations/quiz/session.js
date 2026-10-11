//
// Quiz session controller — glues store, scheduler and ride state to the xf bus.
//
// Reads (xf, see src/db.js / src/watch.js):
//   db:watchStatus  'started' | 'paused' | 'stopped'
//   db:powerTarget  current ERG / workout step target (W)
//   db:power3s      3s power, used when there is no target (free ride)
//   db:ftp
// Emits:
//   quiz:changed        cards/decks changed (manager + panel refresh)
//   quiz:state          {zone, show, allowNew, afterInterval, current, stats}
//   quiz:ride-summary   {reviewed, correct, start, end}  (on ride stop)
//

import { xf } from '../../functions.js';
import { quizStore } from './store.js';
import { buildQueue, stats as computeStats } from './cards.js';
import { RideState } from './ride-state.js';
import * as settings from './settings.js';

const LAST_RIDE_KEY = 'quiz:last-ride';

function Session({ store = quizStore, bus = xf, now = () => Date.now() } = {}) {
    let cards = [];
    let logs = [];
    let current = null;
    let skipped = new Set();
    let rideStart = null;
    let watchStatus = 'stopped';
    const ride = new RideState({ now });
    let loaded = false;

    function cfg() { return settings.load(); }

    async function refresh() {
        cards = await store.listCards();
        logs = await store.listReviews();
        loaded = true;
        pick();
    }

    function gate() {
        const s = cfg();
        ride.afterIntervalMs = (s.afterIntervalMin || 0) * 60 * 1000;
        return ride.gate({ mode: s.mode, newPolicy: s.newPolicy });
    }

    function getStats() {
        const s = cfg();
        return computeStats(cards, logs, now(), { rideStart, newPerDay: s.newPerDay });
    }

    function queue() {
        const s = cfg();
        const g = gate();
        const st = getStats();
        return buildQueue(cards, now(), {
            allowNew: g.allowNew,
            newLimit: st.newAvailable,
            deckId: s.deckId || null,
        });
    }

    // choose the current card; keep it if still due so the UI doesn't jump
    function pick() {
        const q = queue();
        const notSkipped = q.filter(c => !skipped.has(c.id));
        if(notSkipped.length === 0 && q.length > 0) skipped.clear();
        const list = notSkipped.length ? notSkipped : q;
        if(!(current && list.some(c => c.id === current.id))) {
            current = list[0] || null;
        }
        emit();
        return current;
    }

    function state() {
        const g = gate();
        return Object.assign({}, g, {
            loaded, current, stats: getStats(), riding: watchStatus !== 'stopped',
            queueSize: loaded ? queue().length : 0,
        });
    }

    function emit() { bus.dispatch('quiz:state', state()); }

    async function rate(rating) {
        if(!current) return null;
        const s = cfg();
        const { card, log } = await store.reviewCard(current, rating, now(),
                                                     { requestRetention: s.requestRetention });
        cards = cards.map(c => c.id === card.id ? card : c);
        logs = logs.concat([log]);
        skipped.delete(card.id);
        current = null;
        pick();
        return { card, log };
    }

    function skip() {
        if(!current) return;
        skipped.add(current.id);
        current = null;
        pick();
    }

    function onWatchStatus(status) {
        const prev = watchStatus;
        watchStatus = status;
        if(status === 'started' && prev === 'stopped') {
            rideStart = now();
        }
        if(status === 'stopped' && prev !== 'stopped' && rideStart !== null) {
            const st = getStats();
            const summary = {
                reviewed: st.reviewedThisRide, correct: st.rideCorrect,
                start: rideStart, end: now(),
            };
            try { localStorage.setItem(LAST_RIDE_KEY, JSON.stringify(summary)); } catch(e) { /* ignore */ }
            bus.dispatch('quiz:ride-summary', summary);
            rideStart = null;
        }
        ride.update({ running: status === 'started' });
        pick();
    }

    function onRide(patch) {
        const before = ride.zone;
        const beforeAfter = ride.afterInterval();
        ride.update(patch);
        if(ride.zone !== before || ride.afterInterval() !== beforeAfter) pick();
    }

    function start() {
        bus.sub('db:watchStatus', onWatchStatus);
        bus.sub('db:powerTarget', v => onRide({ powerTarget: v }));
        bus.sub('db:power3s',     v => onRide({ power: v }));
        bus.sub('db:ftp',         v => onRide({ ftp: v }));
        bus.sub('quiz:changed',   () => refresh());
        bus.sub('quiz:settings',  () => { current = null; pick(); });
        // re-evaluate learning steps / after-interval window periodically
        setInterval(() => { if(loaded) pick(); }, 30 * 1000);
        return refresh();
    }

    function lastRide() {
        try { return JSON.parse(localStorage.getItem(LAST_RIDE_KEY) || 'null'); } catch(e) { return null; }
    }

    return Object.freeze({ start, refresh, rate, skip, state, pick, lastRide, onWatchStatus, onRide });
}

const session = Session();

export { Session, session, LAST_RIDE_KEY };
