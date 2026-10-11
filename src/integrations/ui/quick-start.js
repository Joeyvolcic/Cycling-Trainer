import { xf } from '../../functions.js';
import { isToday } from '../../utils.js';
import { models } from '../../models/models.js';
import { capabilities } from './platform.js';
import { cachedEntriesForDate, todayISO } from '../plans/plans.js';
import { getActive, isEntryWorkout } from '../plans/today.js';

// <quick-start> — first-run / pre-ride card on the home page:
//   1. connect trainer  2. connect heart rate (optional)  3. one tap "Start <workout>"
// "Today's plan": a local training plan entry for today wins (src/integrations/plans,
// loaded as the workout on startup by plans/today.js, so the big Start button rides
// it and the saved activity marks the entry done); otherwise intervals.icu's planned
// workout for today is offered. The card never loads a workout on its own.
// Hidden once the ride starts; can be dismissed for the session.

const DISMISS_KEY = 'ui:quick-start:dismissed';

function todaysPlanned(planned = []) {
    return planned.find(w => w?.meta?.startDateLocal && isToday(w.meta.startDateLocal));
}

// first not-yet-done local plan entry for today (sync, from the plans cache)
function todaysEntry(date = todayISO()) {
    try {
        return cachedEntriesForDate(date).find(e => e.status === 'planned');
    } catch(e) {
        return undefined;
    }
}

function entryName(entry) {
    return entry?.workoutName ?? entry?.workout?.meta?.name ?? 'workout';
}

// What the card offers for today, given the loaded workout and the active plan entry:
//   {kind: 'plan',      entry, loaded}  local plan entry (loaded = it is the current workout)
//   {kind: 'intervals', workout, loaded} intervals.icu planned workout
//   null                                 nothing planned today
function todayOffer({entry, active, workout, planned = []} = {}) {
    if(entry) {
        const loaded = !!active && active.entryId === entry.id &&
                       active.planId === entry.planId && isEntryWorkout(workout, active);
        return {kind: 'plan', entry, loaded};
    }
    const icu = todaysPlanned(planned);
    if(icu) return {kind: 'intervals', workout: icu, loaded: icu.id === workout?.id};
    return null;
}

function escapeHtml(str = '') {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

class QuickStart extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };

        this.state = {
            watchStatus: 'stopped',
            elapsed: 0,
            workout: undefined,
            active: getActive(),
            dismissed: this.restoreDismissed(),
        };

        this.innerHTML = `
            <div class="qs--card" role="region" aria-label="Quick start">
                <button type="button" class="qs--close" aria-label="Hide quick start">&times;</button>
                <div class="qs--steps">
                    <connection-switch for="ble:controllable" class="qs--connect">
                        <div class="connection-switch--indicator off"></div>
                        <div class="qs--connect--text">
                            <span class="qs--connect--label">Trainer</span>
                            <span class="qs--connect--hint">Tap to connect</span>
                        </div>
                    </connection-switch>
                    <connection-switch for="ble:heartRateMonitor" class="qs--connect">
                        <div class="connection-switch--indicator off"></div>
                        <div class="qs--connect--text">
                            <span class="qs--connect--label">Heart rate</span>
                            <span class="qs--connect--hint">Optional</span>
                        </div>
                    </connection-switch>
                </div>
                <button type="button" class="qs--today" hidden></button>
                <button type="button" class="qs--start">
                    <svg class="qs--start--icon" width="28" height="28" aria-hidden="true"><use href="#icon--play-btn"></use></svg>
                    <span class="qs--start--label">Start ride</span>
                </button>
                <button type="button" class="qs--pick">Choose a different workout</button>
            </div>`;

        this.$start = this.querySelector('.qs--start--label');
        this.$today = this.querySelector('.qs--today');

        this.querySelector('.qs--close').addEventListener('click', () => this.dismiss(), signal);
        this.querySelector('.qs--start').addEventListener('click', () => {
            xf.dispatch('ui:watchStart');
            xf.dispatch('ui:workoutStart');
        }, signal);
        this.querySelector('.qs--pick').addEventListener('click', () => {
            xf.dispatch('ui:page-set', 'workouts');
        }, signal);
        this.$today.addEventListener('click', () => {
            const { kind, id, planId, entryId } = this.$today.dataset;
            if(kind === 'plan' && planId && entryId) {
                xf.dispatch('ui:plans:ride', {planId, entryId});
            } else if(kind === 'intervals' && id) {
                xf.dispatch('ui:planned:select', id);
            }
        }, signal);

        // connect hints
        for(const sw of this.querySelectorAll('.qs--connect')) {
            const id = sw.getAttribute('for');
            const $hint = sw.querySelector('.qs--connect--hint');
            const base = $hint.textContent;
            xf.sub(`${id}:connecting`,   () => $hint.textContent = 'Connecting…', signal);
            xf.sub(`${id}:connected`,    () => $hint.textContent = 'Connected', signal);
            xf.sub(`${id}:disconnected`, () => $hint.textContent = base, signal);
        }
        if(!capabilities().bluetooth) {
            this.querySelectorAll('.qs--connect--hint')
                .forEach(el => el.textContent = 'Needs a Bluetooth browser');
        }

        xf.sub('db:watchStatus', s => { this.state.watchStatus = s; this.render(); }, signal);
        xf.sub('db:elapsed',     t => { this.state.elapsed = t; this.render(); }, signal);
        xf.sub('db:workout',     w => { this.state.workout = w; this.render(); }, signal);
        xf.sub('action:planned', () => this.render(), signal);
        xf.sub('plans:changed',  () => this.render(), signal);
        xf.sub('plans:today',    () => this.render(), signal);
        xf.sub('plans:active',   a => { this.state.active = a; this.render(); }, signal);
        xf.sub('ui:quick-start:show', () => { this.state.dismissed = false; this.saveDismissed(false); this.render(); }, signal);

        this.render();
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    restoreDismissed() {
        try { return sessionStorage.getItem(DISMISS_KEY) === 'true'; } catch(e) { return false; }
    }
    saveDismissed(value) {
        try { sessionStorage.setItem(DISMISS_KEY, String(value)); } catch(e) { /* ignore */ }
    }
    dismiss() {
        this.state.dismissed = true;
        this.saveDismissed(true);
        this.render();
    }
    render() {
        const { watchStatus, elapsed, workout, dismissed } = this.state;
        const visible = !dismissed && watchStatus === 'stopped' && !(elapsed > 0);
        this.classList.toggle('active', visible);
        document.body.classList.toggle('quick-start-open', visible);
        if(!visible) return;

        let planned = [];
        try { planned = models.planned?.list?.() ?? []; } catch(e) { planned = []; }
        const offer = todayOffer({entry: todaysEntry(), active: this.state.active, workout, planned});

        const name = workout?.meta?.name;
        this.$start.textContent =
            offer?.loaded && offer.kind === 'plan' ? `Start today's plan: ${name ?? entryName(offer.entry)}` :
            name ? `Start ${name}` : 'Start free ride';

        const showToday = !!offer && !offer.loaded;
        this.$today.hidden = !showToday;
        delete this.$today.dataset.id;
        delete this.$today.dataset.planId;
        delete this.$today.dataset.entryId;
        if(!showToday) return;
        this.$today.dataset.kind = offer.kind;
        if(offer.kind === 'plan') {
            this.$today.dataset.planId = offer.entry.planId;
            this.$today.dataset.entryId = offer.entry.id;
            this.$today.innerHTML = `Today's plan: <b>${escapeHtml(entryName(offer.entry))}</b> &mdash; load it`;
        } else {
            this.$today.dataset.id = offer.workout.id;
            this.$today.innerHTML = `Today's plan (intervals.icu): <b>${escapeHtml(offer.workout.meta.name)}</b> &mdash; load it`;
        }
    }
}

customElements.get('quick-start') || customElements.define('quick-start', QuickStart);

export { QuickStart, todaysPlanned, todaysEntry, todayOffer };
