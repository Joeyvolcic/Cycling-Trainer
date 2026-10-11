// <x-ai-panel>    readiness check panel (registered in the integrations dock)
// <x-ai-settings> API keys / model selection (Settings page)
import { xf } from '../../functions.js';
import {
    isConfigured, getKey, setKey, clearKey, getModel, setModel, MODELS,
} from './claude.js';
import {
    getWellness, getManualWellness, saveManualWellness, clearManualWellness,
    getIntervalsKey, getIntervalsAthleteId, setIntervalsKey, isoDate,
} from './wellness.js';
import { zoneOf, workoutDuration } from './adjust.js';
import {
    getCandidates, checkReadiness, acceptResult, rejectResult, getLog,
} from './readiness.js';

function esc(x) {
    return String(x ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

const STYLE_ID = 'ai-integration-style';
const CSS = `
.ai-panel, .ai-settings { display: flex; flex-direction: column; gap: 0.75em; padding: 0.75em; color: var(--foreground-color, #fff); font-size: 1.6rem; line-height: 1.35; text-align: left; }
.ai-panel h3, .ai-settings h2 { margin: 0; font-size: 1.1em; }
.ai-panel .ai-muted, .ai-settings .ai-muted { color: var(--foreground-color-inactive, #aaa); font-size: 0.85em; }
.ai-row { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; }
.ai-btn { min-height: 44px; min-width: 44px; padding: 0 1em; border-radius: 0.5em; border: 1px solid var(--border-color, #fff3);
  background: transparent; color: inherit; font: inherit; cursor: pointer; touch-action: manipulation; }
.ai-btn.primary { background: var(--zone-blue, #328AFF); border-color: transparent; color: #fff; }
.ai-btn.danger { border-color: var(--red, #FF495F); color: var(--red, #FF495F); }
.ai-btn.selected { border-color: var(--zone-blue, #328AFF); box-shadow: inset 0 0 0 2px var(--zone-blue, #328AFF); }
.ai-btn[disabled] { opacity: 0.5; cursor: default; }
.ai-chip { padding: 0.25em 0.6em; border-radius: 1em; background: var(--border-color, #fff2); font-size: 0.9em; }
.ai-card { border: 1px solid var(--border-color, #fff3); border-radius: 0.75em; padding: 0.75em; display: flex; flex-direction: column; gap: 0.5em; }
.ai-scale { display: flex; gap: 0.35em; }
.ai-scale .ai-btn { padding: 0; width: 44px; }
.ai-field { display: flex; flex-direction: column; gap: 0.3em; }
.ai-input { min-height: 44px; padding: 0 0.75em; border-radius: 0.5em; border: 1px solid var(--border-color, #fff3);
  background: transparent; color: inherit; font: inherit; box-sizing: border-box; width: 100%; max-width: 28em; }
textarea.ai-input { min-height: 4em; padding: 0.5em 0.75em; }
select.ai-input option { color: #000; }
.ai-graph { width: 100%; height: 72px; display: block; background: var(--border-color, #fff1); border-radius: 0.4em; }
.ai-graph-label { display: flex; justify-content: space-between; font-size: 0.85em; }
.ai-decision { font-weight: bold; text-transform: capitalize; }
.ai-warning { border-left: 3px solid var(--yellow, #F8C73A); padding-left: 0.6em; font-size: 0.9em; }
.ai-error { color: var(--red, #FF495F); }
.ai-log-item { font-size: 0.85em; padding: 0.3em 0; border-bottom: 1px solid var(--border-color, #fff2); }
`;

function injectStyle() {
    if(document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

// Same x/y scale for before/after so the comparison is honest.
function graphSVG(workout, {maxDuration, maxPower = 1.3} = {}) {
    if(!workout) {
        return `<svg class="ai-graph" viewBox="0 0 1000 100" preserveAspectRatio="none">
            <text x="500" y="58" text-anchor="middle" font-size="22" fill="currentColor">Rest day</text></svg>`;
    }
    const total = maxDuration ?? workoutDuration(workout);
    const x = (t) => (t / total) * 1000;
    const y = (p) => 100 - Math.min(1, Math.max(0.04, p / maxPower)) * 100;
    let t = 0;
    let polys = '';
    for(const interval of workout.intervals ?? []) {
        for(const step of interval.steps ?? []) {
            const d = step.duration ?? 0;
            const p = step.power ?? 0;
            polys += `<rect x="${x(t).toFixed(2)}" y="${y(p).toFixed(2)}" width="${Math.max(0.5, x(d)).toFixed(2)}" height="${(100 - y(p)).toFixed(2)}" fill="${zoneOf(p).color}"/>`;
            t += d;
        }
    }
    return `<svg class="ai-graph" viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="workout profile">${polys}</svg>`;
}

const SCALE_FIELDS = [
    {name: 'sleepQuality', label: 'Sleep quality', hint: '1 poor · 5 great'},
    {name: 'feel',         label: 'How do you feel?', hint: '1 awful · 5 great'},
    {name: 'soreness',     label: 'Soreness', hint: '1 none · 5 very sore'},
    {name: 'stress',       label: 'Stress', hint: '1 none · 5 very high'},
];

class AiPanel extends HTMLElement {
    connectedCallback() {
        injectStyle();
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.date = isoDate();
        this.candidates = [];
        this.selectedKey = undefined;
        this.wellness = undefined;
        this.result = undefined;
        this.busy = false;
        this.error = '';
        this.showCheckin = false;

        this.addEventListener('click', this.onClick.bind(this), signal);
        this.addEventListener('submit', this.onSubmit.bind(this), signal);
        xf.sub('db:workout', () => this.refreshCandidates(), signal);
        xf.sub('action:planned', () => this.refreshCandidates(), signal);
        xf.sub('plans:changed', () => this.refreshCandidates(), signal);
        xf.sub('ai:settings', () => this.refresh(), signal);

        this.refresh();
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    async refresh() {
        this.date = isoDate();
        await Promise.all([this.refreshCandidates(false), this.refreshWellness(false)]);
        this.render();
    }
    async refreshCandidates(render = true) {
        try {
            this.candidates = await getCandidates(this.date);
        } catch(e) {
            this.candidates = [];
        }
        if(!this.candidates.some((c) => c.key === this.selectedKey)) {
            this.selectedKey = this.candidates[0]?.key;
        }
        if(render) this.render();
    }
    async refreshWellness(render = true) {
        try {
            this.wellness = await getWellness(this.date);
        } catch(e) {
            this.wellness = {source: 'none'};
        }
        if(render) this.render();
    }
    selected() {
        return this.candidates.find((c) => c.key === this.selectedKey);
    }
    async onClick(e) {
        const btn = e.target.closest('[data-action]');
        if(!btn || !this.contains(btn)) return;
        const action = btn.dataset.action;

        if(action === 'select') {
            this.selectedKey = btn.dataset.key;
            this.result = undefined;
            this.render();
        } else if(action === 'toggle-planner') {
            this.showPlanner = !this.showPlanner;
            this.render();
        } else if(action === 'toggle-checkin') {
            this.showCheckin = !this.showCheckin;
            this.render();
        } else if(action === 'scale') {
            const group = btn.closest('[data-scale]');
            group.querySelectorAll('.ai-btn').forEach((b) => b.classList.remove('selected'));
            btn.classList.add('selected');
            group.querySelector('input').value = btn.dataset.value;
        } else if(action === 'clear-checkin') {
            clearManualWellness(this.date);
            this.showCheckin = false;
            await this.refreshWellness();
        } else if(action === 'check') {
            await this.runCheck();
        } else if(action === 'accept') {
            await acceptResult(this.result, this.selected());
            this.result = Object.assign({}, this.result, {outcome: 'accepted'});
            this.render();
        } else if(action === 'reject') {
            rejectResult(this.result);
            this.result = Object.assign({}, this.result, {outcome: 'rejected'});
            this.render();
        }
    }
    async onSubmit(e) {
        if(!e.target.matches('.ai-checkin')) return;
        e.preventDefault();
        const data = Object.fromEntries(new FormData(e.target).entries());
        saveManualWellness(this.date, data);
        this.showCheckin = false;
        await this.refreshWellness();
    }
    async runCheck() {
        const candidate = this.selected();
        if(!candidate) return;
        this.busy = true;
        this.error = '';
        this.result = undefined;
        this.render();
        try {
            this.result = await checkReadiness({workout: candidate.workout, date: this.date});
            this.wellness = this.result.wellness;
        } catch(e) {
            console.error(':ai :readiness', e);
            this.error = e.message ?? String(e);
        }
        this.busy = false;
        this.render();
    }
    renderWellness() {
        const w = this.wellness ?? {};
        const chips = [];
        const add = (label, value, unit = '') => {
            if(value !== undefined) chips.push(`<span class="ai-chip">${esc(label)} ${esc(value)}${unit}</span>`);
        };
        add('Sleep', w.sleepHours, 'h');
        add('Sleep score', w.sleepScore);
        add('Sleep quality', w.sleepQuality, '/5');
        add('HRV', w.hrv);
        add('HRV 7d', w.hrvBaseline);
        add('RHR', w.restingHR);
        add('Readiness', w.readiness);
        add('Feel', w.feel, '/5');
        add('Soreness', w.soreness, '/5');
        add('Stress', w.stress, '/5');
        add('Form (TSB)', w.tsb);

        return `
            <div class="ai-card">
                <div class="ai-row" style="justify-content: space-between">
                    <h3>Recovery</h3>
                    <span class="ai-muted">source: ${esc(w.source ?? 'none')}</span>
                </div>
                <div class="ai-row">${chips.join('') || '<span class="ai-muted">No wellness data yet. Connect intervals.icu in Settings or check in below.</span>'}</div>
                <div class="ai-row">
                    <button class="ai-btn" data-action="toggle-checkin">${this.showCheckin ? 'Close check-in' : 'Morning check-in'}</button>
                </div>
                ${this.showCheckin ? this.renderCheckin() : ''}
            </div>`;
    }
    renderCheckin() {
        const m = getManualWellness(this.date) ?? {};
        const scale = (f) => `
            <div class="ai-field" data-scale="${f.name}">
                <span>${esc(f.label)} <span class="ai-muted">${esc(f.hint)}</span></span>
                <div class="ai-scale">
                    ${[1, 2, 3, 4, 5].map((v) => `<button type="button" class="ai-btn ${m[f.name] === v ? 'selected' : ''}" data-action="scale" data-value="${v}">${v}</button>`).join('')}
                </div>
                <input type="hidden" name="${f.name}" value="${esc(m[f.name] ?? '')}">
            </div>`;
        return `
            <form class="ai-checkin ai-card">
                <label class="ai-field">Hours slept
                    <input class="ai-input" name="sleepHours" type="number" inputmode="decimal" min="0" max="24" step="0.25" value="${esc(m.sleepHours ?? '')}">
                </label>
                ${SCALE_FIELDS.map(scale).join('')}
                <label class="ai-field">Notes (illness, travel, life stress…)
                    <textarea class="ai-input" name="notes" maxlength="500">${esc(m.notes ?? '')}</textarea>
                </label>
                <div class="ai-row">
                    <button class="ai-btn primary" type="submit">Save check-in</button>
                    <button class="ai-btn" type="button" data-action="clear-checkin">Clear</button>
                </div>
            </form>`;
    }
    renderCandidates() {
        if(this.candidates.length === 0) {
            return `<p class="ai-muted">No workout planned for today. Select a workout in the library or add one to your plan.</p>`;
        }
        return `<div class="ai-row">${this.candidates.map((c) => `
            <button class="ai-btn ${c.key === this.selectedKey ? 'selected' : ''}" data-action="select" data-key="${esc(c.key)}">
                ${esc(c.label)} <span class="ai-muted">· ${esc(c.source)} · ${Math.round(workoutDuration(c.workout) / 60)}min</span>
            </button>`).join('')}</div>`;
    }
    renderResult() {
        const r = this.result;
        if(!r) return '';
        const d = r.decision;
        const maxDuration = Math.max(r.before.duration, r.after?.duration ?? 0) || 1;
        const maxPower = Math.max(1.3, r.before.maxPower, r.after?.maxPower ?? 0) * 1.05;
        const fmt = (m) => m ? `${m.minutes} min · TSS ${m.tss} · IF ${m.if}` : 'Rest';
        const label = d.decision.replace(/_/g, ' ') +
              (d.decision.includes('scale') ? ` ${d.intensityPercent}%` : '') +
              ((d.decision.includes('shorten') || d.decision.startsWith('swap')) ? ` · ${d.durationMinutes} min` : '');

        const actions = r.outcome ?
              `<p class="ai-muted">${r.outcome === 'accepted' ?
                   (r.adjusted ? (r.decision.decision === 'keep' ? 'Accepted — riding as planned.' :
                                  `Accepted — the adjusted workout is loaded and saved to your library${this.selected()?.entry ? ' and plan' : ''}.`) :
                    'Accepted — enjoy the rest day.') :
                   'Rejected — riding the original plan.'}</p>` :
              `<div class="ai-row">
                   <button class="ai-btn primary" data-action="accept">${r.adjusted ? 'Accept & load' : 'Accept rest day'}</button>
                   <button class="ai-btn" data-action="reject">Keep original</button>
               </div>`;

        return `
            <div class="ai-card">
                <div class="ai-row" style="justify-content: space-between">
                    <span class="ai-decision">${esc(label)}</span>
                    <span class="ai-chip">readiness: ${esc(d.readiness.replace('_', ' '))}</span>
                </div>
                <p style="margin:0">${esc(d.rationale)}</p>
                ${d.keyFactors.length ? `<div class="ai-row">${d.keyFactors.map((k) => `<span class="ai-chip">${esc(k)}</span>`).join('')}</div>` : ''}
                <div class="ai-graph-label"><span>Before</span><span>${esc(fmt(r.before))}</span></div>
                ${graphSVG(r.original, {maxDuration, maxPower})}
                <div class="ai-graph-label"><span>After</span><span>${esc(fmt(r.after))}</span></div>
                ${graphSVG(r.adjusted, {maxDuration, maxPower})}
                ${actions}
                <p class="ai-muted">Suggested by ${esc(r.model)}. Training guidance only, not medical advice.</p>
            </div>`;
    }
    renderLog() {
        const log = getLog().slice(0, 5);
        if(log.length === 0) return '';
        return `
            <details class="ai-card">
                <summary style="min-height:44px; display:flex; align-items:center; cursor:pointer">Recent decisions</summary>
                ${log.map((l) => `<div class="ai-log-item">${esc(l.date)} · ${esc(l.workout)} · ${esc(l.decision?.decision?.replace(/_/g, ' '))} · <b>${esc(l.outcome)}</b></div>`).join('')}
            </details>`;
    }
    render() {
        const configured = isConfigured();
        const canCheck = configured && !!this.selected() && !this.busy;
        this.innerHTML = `
            <div class="ai-panel">
                <div class="ai-row" style="justify-content: space-between">
                    <h3>Readiness check</h3>
                    <span class="ai-muted">${esc(this.date)}</span>
                </div>
                ${configured ? '' : '<p class="ai-warning">Add your Anthropic API key in Settings → AI Coach to enable readiness checks.</p>'}
                ${this.renderCandidates()}
                ${this.renderWellness()}
                <button class="ai-btn primary" data-action="check" ${canCheck ? '' : 'disabled'}>
                    ${this.busy ? 'Asking Claude…' : 'Check readiness'}
                </button>
                ${this.error ? `<p class="ai-error">${esc(this.error)}</p>` : ''}
                ${this.renderResult()}
                <button class="ai-btn" data-action="toggle-planner" aria-expanded="${this.showPlanner ? 'true' : 'false'}">
                    ${this.showPlanner ? 'Close planner' : 'Plan my week(s)'}
                </button>
                ${this.showPlanner ? '<x-ai-planner></x-ai-planner>' : ''}
                ${this.renderLog()}
            </div>`;
    }
}

class AiSettings extends HTMLElement {
    connectedCallback() {
        injectStyle();
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.addEventListener('click', this.onClick.bind(this), signal);
        this.addEventListener('change', this.onChange.bind(this), signal);
        this.render();
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    onChange(e) {
        if(e.target.name === 'ai-model') {
            setModel(e.target.value);
            xf.dispatch('ai:settings', 'model');
        }
    }
    onClick(e) {
        const btn = e.target.closest('[data-action]');
        if(!btn) return;
        const action = btn.dataset.action;
        if(action === 'save-key') {
            setKey(this.querySelector('[name="ai-key"]').value);
        } else if(action === 'clear-key') {
            clearKey();
        } else if(action === 'save-icu') {
            setIntervalsKey(
                this.querySelector('[name="icu-key"]').value,
                this.querySelector('[name="icu-athlete"]').value,
            );
        } else if(action === 'clear-icu') {
            setIntervalsKey('');
        } else {
            return;
        }
        xf.dispatch('ai:settings', action);
        this.render();
    }
    render() {
        const key = getKey();
        const masked = key ? `${key.slice(0, 7)}…${key.slice(-4)}` : '';
        const icuKey = getIntervalsKey();
        const model = getModel();
        this.innerHTML = `
            <div class="ai-settings">
                <h2 class="list--sub-heading">AI Coach</h2>
                <div class="ai-card">
                    <label class="ai-field">Anthropic API key
                        <input class="ai-input" name="ai-key" type="password" autocomplete="off" spellcheck="false"
                               placeholder="${key ? esc(masked) : 'sk-ant-…'}">
                    </label>
                    <p class="ai-warning">Your key is stored only in this browser on this device (localStorage) and is sent directly to api.anthropic.com. Anyone with access to this device or browser profile can read it, and usage is billed to your Anthropic account. Use a dedicated key with a spend limit and clear it on shared devices.</p>
                    <div class="ai-row">
                        <button class="ai-btn primary" data-action="save-key">Save key</button>
                        <button class="ai-btn danger" data-action="clear-key" ${key ? '' : 'disabled'}>Clear key</button>
                        <span class="ai-muted">${key ? `Saved: ${esc(masked)}` : 'No key saved'}</span>
                    </div>
                    <label class="ai-field">Model
                        <select class="ai-input" name="ai-model">
                            ${MODELS.map((m) => `<option value="${m.id}" ${m.id === model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="ai-card">
                    <label class="ai-field">intervals.icu API key (optional, for sleep/HRV/recovery)
                        <input class="ai-input" name="icu-key" type="password" autocomplete="off" spellcheck="false"
                               placeholder="${icuKey ? 'saved' : 'intervals.icu → Settings → Developer Settings'}">
                    </label>
                    <label class="ai-field">intervals.icu athlete ID (optional, e.g. i12345)
                        <input class="ai-input" name="icu-athlete" type="text" autocomplete="off" spellcheck="false"
                               value="${esc(icuKey && getIntervalsAthleteId() !== '0' ? getIntervalsAthleteId() : '')}">
                    </label>
                    <p class="ai-muted">Without a key we try your existing intervals.icu connection, then fall back to your manual morning check-in. This key is also stored only on this device.</p>
                    <div class="ai-row">
                        <button class="ai-btn primary" data-action="save-icu">Save</button>
                        <button class="ai-btn danger" data-action="clear-icu" ${icuKey ? '' : 'disabled'}>Clear</button>
                        <span class="ai-muted">${icuKey ? 'Key saved' : 'No key saved'}</span>
                    </div>
                </div>
            </div>`;
    }
}

customElements.define('x-ai-panel', AiPanel);
customElements.define('x-ai-settings', AiSettings);

export { AiPanel, AiSettings, graphSVG, injectStyle, esc };
