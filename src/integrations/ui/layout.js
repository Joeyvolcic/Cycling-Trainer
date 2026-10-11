import { xf } from '../../functions.js';

// Home page layouts (see doc/ui-proposals/index.html for the mockups)
//
// classic - the original full-screen data view (default)
// banner  - (A) compact workout strip on top, integrations dock fills the rest
// split   - (B) workout half + dock half (side by side in landscape, stacked in portrait)
// focus   - (C) banner that auto-expands around interval changes and when paused
//
// The choice lives on <body data-layout="..."> and is styled in css/layouts.css.

const LAYOUTS = [
    {id: 'classic', name: 'Classic', hint: 'Full-screen data, as before'},
    {id: 'banner',  name: 'Banner',  hint: 'Workout strip on top, panels below'},
    {id: 'split',   name: 'Split',   hint: 'Half workout, half panels'},
    {id: 'focus',   name: 'Focus',   hint: 'Banner that grows near interval changes'},
];
const DEFAULT_LAYOUT = 'classic';
const STORAGE_KEY = 'ui:layout';

function isValidLayout(id) {
    return LAYOUTS.some(l => l.id === id);
}

function restoreLayout(storage = globalThis.localStorage) {
    try {
        const value = storage?.getItem(STORAGE_KEY);
        return isValidLayout(value) ? value : DEFAULT_LAYOUT;
    } catch(e) {
        return DEFAULT_LAYOUT;
    }
}

function backupLayout(id, storage = globalThis.localStorage) {
    try { storage?.setItem(STORAGE_KEY, id); } catch(e) { /* private mode */ }
}

// Focus mode: decide whether the workout area should be expanded.
//
// state = {
//   running: bool,           // watch started (not paused / stopped)
//   workout: bool,           // a structured workout is in progress (lapTime counts down)
//   lapTime: seconds,        // remaining in interval (workout) or elapsed in lap (free ride)
//   intervalDuration: sec,   // total length of the current interval (workout only)
//   pinnedUntil: ms epoch,   // user tapped expand; stay expanded until then
//   now: ms epoch,
// }
const FOCUS_LEAD_IN  = 20; // expand this many seconds before an interval ends
const FOCUS_LEAD_OUT = 10; // and stay expanded this long into the new interval

function focusExpanded(state = {}) {
    const now = state.now ?? Date.now();
    if((state.pinnedUntil ?? 0) > now) return true;
    if(!state.running) return true;
    if(!state.workout) return false;

    const remaining = state.lapTime ?? 0;
    const duration  = state.intervalDuration ?? 0;
    const elapsed   = duration > 0 ? duration - remaining : Infinity;

    if(remaining <= FOCUS_LEAD_IN) return true;
    if(elapsed < FOCUS_LEAD_OUT) return true;
    return false;
}

function notifyResize() {
    // workout-graph and moxy-graph re-measure on window resize
    if(typeof window === 'undefined') return;
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function applyLayout(id) {
    if(typeof document === 'undefined') return;
    document.body.dataset.layout = id;
    xf.dispatch('ui:layout', id);
    notifyResize();
}

function FocusController() {
    const state = {
        running: false, workout: false, lapTime: 0, intervalDuration: 0, pinnedUntil: 0,
    };
    let current;
    let resizeTimer;

    function update() {
        const expanded = focusExpanded({...state, now: Date.now()});
        const value = expanded ? 'expanded' : 'collapsed';
        if(value === current) return;
        current = value;
        document.body.dataset.focus = value;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(notifyResize, 350); // after the CSS transition
    }

    xf.sub('db:watchStatus',      s => { state.running = (s === 'started'); update(); });
    xf.sub('db:workoutStatus',    s => { state.workout = (s === 'started'); update(); });
    xf.sub('db:lapTime',          t => { state.lapTime = t; update(); });
    xf.sub('db:intervalDuration', t => { state.intervalDuration = t; update(); });
    xf.sub('ui:focus:pin', (seconds = 30) => {
        state.pinnedUntil = Date.now() + seconds * 1000;
        update();
        setTimeout(update, seconds * 1000 + 50);
    });
    xf.sub('ui:focus:unpin', () => { state.pinnedUntil = 0; update(); });

    update();
    return Object.freeze({ update, state });
}

// <layout-select></layout-select> — segmented control for the Settings page
class LayoutSelect extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };

        this.classList.add('layout-select');
        this.setAttribute('role', 'radiogroup');
        this.innerHTML = LAYOUTS.map(l =>
            `<button type="button" class="layout-select--btn" role="radio" data-layout="${l.id}">
                <span class="layout-select--icon layout-icon--${l.id}" aria-hidden="true"></span>
                <span class="layout-select--name">${l.name}</span>
                <span class="layout-select--hint">${l.hint}</span>
             </button>`).join('');

        this.addEventListener('click', e => {
            const btn = e.target.closest('[data-layout]');
            if(btn) xf.dispatch('ui:layout-set', btn.dataset.layout);
        }, signal);
        xf.sub('ui:layout', this.render.bind(this), signal);
        this.render(document.body.dataset.layout ?? restoreLayout());
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    render(id) {
        this.querySelectorAll('[data-layout]').forEach(btn => {
            const active = btn.dataset.layout === id;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
    }
}

function nextLayout(id) {
    const i = LAYOUTS.findIndex(l => l.id === id);
    return LAYOUTS[(i + 1) % LAYOUTS.length].id;
}

// <layout-cycle> — small header button to flip through layouts while riding
class LayoutCycle extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };
        this.setAttribute('tabindex', '0');
        this.addEventListener('click', () => {
            xf.dispatch('ui:layout-set', nextLayout(document.body.dataset.layout ?? DEFAULT_LAYOUT));
        }, signal);
        xf.sub('ui:layout', id => this.render(id), signal);
        this.render(document.body.dataset.layout ?? restoreLayout());
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    render(id) {
        const layout = LAYOUTS.find(l => l.id === id) ?? LAYOUTS[0];
        this.innerHTML =
            `<span class="layout-select--icon layout-icon--${layout.id}" aria-hidden="true"></span>
             <span class="layout-cycle--label">${layout.name}</span>`;
        this.setAttribute('aria-label', `Layout: ${layout.name}. Tap to switch.`);
    }
}

function startFocusToggle() {
    const btn = document.getElementById('focus-toggle');
    if(!btn) return;
    btn.addEventListener('click', () => {
        if(document.body.dataset.focus === 'expanded') {
            xf.dispatch('ui:focus:unpin');
        } else {
            xf.dispatch('ui:focus:pin', 30);
        }
    });
}

function start() {
    if(typeof document === 'undefined') return;
    customElements.get('layout-select') || customElements.define('layout-select', LayoutSelect);
    customElements.get('layout-cycle') || customElements.define('layout-cycle', LayoutCycle);
    startFocusToggle();

    xf.sub('ui:layout-set', id => {
        if(!isValidLayout(id)) return;
        backupLayout(id);
        applyLayout(id);
    });

    applyLayout(restoreLayout());
    FocusController();
}

export {
    LAYOUTS,
    DEFAULT_LAYOUT,
    STORAGE_KEY,
    FOCUS_LEAD_IN,
    FOCUS_LEAD_OUT,
    isValidLayout,
    restoreLayout,
    backupLayout,
    focusExpanded,
    nextLayout,
    start,
};
