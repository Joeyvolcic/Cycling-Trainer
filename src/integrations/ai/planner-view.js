// <x-ai-planner>       "Plan my week(s)": goal + availability -> Claude -> reviewable week grid -> plan + calendar
// <x-ai-plan-changes>  post-ride coach feedback -> proposed plan changes (diff with checkboxes) -> apply
//
// State lives at module level (not in the element) because host views re-render
// their innerHTML often (plans:changed, db:workout…): a fresh element picks up
// where the previous one left off. Instances re-render on `ai:planner:state`.
import { xf } from '../../functions.js';
import { idb } from '../../storage/idb.js';
import { listPlans } from '../plans/plans.js';
import { isConfigured } from './claude.js';
import { graphSVG, injectStyle, esc } from './views.js';
import { WEEKDAY_NAMES, weekTotals } from './planner-core.js';
import {
    GOALS, defaultForm, proposePlan, acceptPlan, proposeChanges, applyChanges,
    googleConnected, exportIcs,
} from './planner.js';

const STYLE_ID = 'ai-planner-style';
const CSS = `
.aip { container-type: inline-size; display: flex; flex-direction: column; gap: 0.75em; text-align: left; }
.aip-grid2 { display: grid; grid-template-columns: repeat(auto-fill, minmax(12em, 1fr)); gap: 0.75em; }
.aip-days { display: flex; flex-wrap: wrap; gap: 0.35em; }
.aip-days .ai-btn { padding: 0 0.6em; }
.aip-check { display: flex; align-items: center; gap: 0.6em; min-height: 44px; cursor: pointer; }
.aip-check input { width: 24px; height: 24px; margin: 0; flex: none; }
.aip-week-head { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.5em; font-weight: bold; }
.aip-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.4em; }
.aip-day { border: 1px solid var(--border-color, #fff3); border-radius: 0.5em; padding: 0.4em; display: flex; flex-direction: column; gap: 0.3em; min-width: 0; font-size: 0.85em; }
.aip-day.off { opacity: 0.55; }
.aip-day-date { font-weight: bold; }
.aip-session { display: flex; flex-direction: column; gap: 0.25em; }
.aip-session.excluded { opacity: 0.45; }
.aip-session .ai-graph { height: 40px; }
.aip-name { overflow-wrap: anywhere; }
.aip-existing { color: var(--foreground-color-inactive, #aaa); font-style: italic; overflow-wrap: anywhere; }
.aip-warn { color: var(--yellow, #F8C73A); font-size: 0.9em; }
.aip-change { display: grid; grid-template-columns: 44px 1fr; gap: 0.5em; align-items: start; border: 1px solid var(--border-color, #fff3); border-radius: 0.5em; padding: 0.5em; cursor: pointer; }
.aip-change input { width: 24px; height: 24px; margin: 10px; }
.aip-diff { display: flex; flex-wrap: wrap; gap: 0.4em; align-items: center; }
.aip-before { text-decoration: line-through; color: var(--foreground-color-inactive, #aaa); }
@container (max-width: 720px) {
  .aip-week { grid-template-columns: 1fr; }
  .aip-day.empty { display: none; }
  .aip-session .ai-graph { height: 56px; }
}
`;

function injectPlannerStyle() {
    injectStyle();
    if(document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
}

function notify() {
    xf.dispatch('ai:planner:state', Date.now());
}

function dayLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return `${WEEKDAY_NAMES[date.getDay()]} ${d}/${m}`;
}

// totals of the included sessions in a 7-day block (which may straddle two calendar weeks)
function blockTotals(entries) {
    const t = weekTotals(entries).reduce((acc, w) => ({
        count: acc.count + w.count, minutes: acc.minutes + w.minutes, tss: acc.tss + w.tss,
    }), {count: 0, minutes: 0, tss: 0});
    return t.count ? t : null;
}

function hours(minutes) {
    return `${Math.round((minutes ?? 0) / 6) / 10} h`;
}

// ----------------------------------------------------------------------------
// <x-ai-planner>
// ----------------------------------------------------------------------------

const session = {
    form: undefined,
    status: 'form', // form | busy | preview | saving | done
    preview: undefined,
    outcome: undefined,
    error: '',
    plans: [],
};

function form() {
    if(!session.form) session.form = defaultForm();
    return session.form;
}

const NUMERIC = new Set(['weeks', 'weekdayMinutes', 'weekendMinutes', 'weeklyHours', 'ftp']);

class AiPlanner extends HTMLElement {
    connectedCallback() {
        injectPlannerStyle();
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.addEventListener('click', this.onClick.bind(this), signal);
        this.addEventListener('change', this.onInput.bind(this), signal);
        this.addEventListener('input', this.onInput.bind(this), signal);
        this.addEventListener('submit', this.onSubmit.bind(this), signal);
        xf.sub('ai:planner:state', () => this.render(), signal);
        xf.sub('ai:settings', () => this.render(), signal);
        this.render();
        listPlans().then((plans) => {
            session.plans = plans.map((p) => ({id: p.id, name: p.name}));
            if(session.status === 'form') this.render();
        }).catch(() => {});
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    onInput(e) {
        const el = e.target;
        if(!el.name || !el.closest('.aip-form')) return;
        const f = form();
        if(el.type === 'checkbox') f[el.name] = el.checked;
        else if(NUMERIC.has(el.name)) f[el.name] = el.value === '' ? '' : Number(el.value);
        else f[el.name] = el.value;
    }
    async onSubmit(e) {
        if(!e.target.matches('.aip-form')) return;
        e.preventDefault();
        await this.propose();
    }
    async propose() {
        session.status = 'busy';
        session.error = '';
        notify();
        try {
            session.preview = await proposePlan(Object.assign({}, form()));
            session.status = 'preview';
        } catch(err) {
            console.error(':ai :planner', err);
            session.error = err.message ?? String(err);
            session.status = 'form';
        }
        notify();
    }
    async onClick(e) {
        const btn = e.target.closest('[data-action]');
        if(!btn || !this.contains(btn)) return;
        const action = btn.dataset.action;
        if(action === 'toggle-day') {
            const day = Number(btn.dataset.day);
            const f = form();
            f.days = f.days.includes(day) ? f.days.filter((d) => d !== day) : f.days.concat(day).sort();
            this.render();
        } else if(action === 'include') {
            const p = session.preview?.entries.find((x) => x.key === btn.dataset.key);
            if(p) p.include = btn.checked;
            notify();
        } else if(action === 'regenerate') {
            await this.propose();
        } else if(action === 'back') {
            session.status = 'form';
            notify();
        } else if(action === 'accept') {
            await this.accept();
        } else if(action === 'again') {
            session.status = 'form';
            session.preview = undefined;
            session.outcome = undefined;
            notify();
        } else if(action === 'ics') {
            exportIcs({open: btn.dataset.open === 'true'});
        } else if(action === 'calendar-settings') {
            xf.dispatch('ui:page-set', 'settings');
            setTimeout(() => document.getElementById('calendar-settings')?.scrollIntoView({behavior: 'smooth'}), 100);
        }
    }
    async accept() {
        session.status = 'saving';
        session.error = '';
        notify();
        try {
            const target = session.plans.find((p) => p.id === session.preview.form.planId);
            session.outcome = await acceptPlan(session.preview, {planId: target?.id});
            session.status = 'done';
        } catch(err) {
            console.error(':ai :planner :accept', err);
            session.error = err.message ?? String(err);
            session.status = 'preview';
        }
        notify();
    }
    renderForm() {
        const f = form();
        const busy = session.status === 'busy';
        const configured = isConfigured();
        return `
            <form class="aip-form ai-card">
                <div class="aip-grid2">
                    <label class="ai-field">Goal
                        <select class="ai-input" name="goal">
                            ${GOALS.map((g) => `<option value="${g.id}" ${g.id === f.goal ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="ai-field">Event date (optional)
                        <input class="ai-input" type="date" name="eventDate" value="${esc(f.eventDate)}">
                    </label>
                </div>
                <label class="ai-field">Details (optional)
                    <textarea class="ai-input" name="goalDetails" maxlength="300" placeholder="e.g. 3h gran fondo, weak at VO2 efforts, no sessions Friday">${esc(f.goalDetails)}</textarea>
                </label>
                <div class="aip-grid2">
                    <label class="ai-field">Start
                        <input class="ai-input" type="date" name="startDate" value="${esc(f.startDate)}">
                    </label>
                    <label class="ai-field">Weeks
                        <select class="ai-input" name="weeks">
                            ${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(f.weeks) === n ? 'selected' : ''}>${n}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <div class="ai-field">
                    <span>Days I can ride <span class="ai-muted">(from your calendar windows)</span></span>
                    <div class="aip-days">
                        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<button type="button" class="ai-btn ${f.days.includes(d) ? 'selected' : ''}"
                            data-action="toggle-day" data-day="${d}" aria-pressed="${f.days.includes(d)}">${WEEKDAY_NAMES[d]}</button>`).join('')}
                    </div>
                </div>
                <div class="aip-grid2">
                    <label class="ai-field">Max minutes, weekdays
                        <input class="ai-input" type="number" inputmode="numeric" min="15" max="360" step="5" name="weekdayMinutes" value="${esc(f.weekdayMinutes)}">
                    </label>
                    <label class="ai-field">Max minutes, weekend
                        <input class="ai-input" type="number" inputmode="numeric" min="15" max="480" step="5" name="weekendMinutes" value="${esc(f.weekendMinutes)}">
                    </label>
                    <label class="ai-field">Hours per week
                        <input class="ai-input" type="number" inputmode="decimal" min="1" max="30" step="0.5" name="weeklyHours" value="${esc(f.weeklyHours)}">
                    </label>
                    <label class="ai-field">FTP (W)
                        <input class="ai-input" type="number" inputmode="numeric" min="50" max="600" name="ftp" value="${esc(f.ftp)}">
                    </label>
                </div>
                <div class="aip-grid2">
                    <label class="ai-field">Add to
                        <select class="ai-input" name="planId">
                            <option value="">New plan</option>
                            ${session.plans.map((p) => `<option value="${esc(p.id)}" ${p.id === f.planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="aip-check">
                        <input type="checkbox" name="replaceExisting" ${f.replaceExisting ? 'checked' : ''}>
                        Replace that plan's planned rides in this period
                    </label>
                </div>
                <p class="ai-muted">Sends your goal, availability, FTP, recent load, wellness, existing plan entries and a list of your library workouts to Claude.</p>
                <button class="ai-btn primary" type="submit" ${configured && !busy ? '' : 'disabled'}>
                    ${busy ? 'Claude is planning…' : 'Plan with Claude'}
                </button>
                ${configured ? '' : '<p class="ai-warning">Add your Anthropic API key in Settings → AI Coach first.</p>'}
            </form>`;
    }
    renderSession(p) {
        const excluded = p.include === false;
        return `
            <div class="aip-session ${excluded ? 'excluded' : ''}">
                <label class="aip-check">
                    <input type="checkbox" data-action="include" data-key="${esc(p.key)}" ${excluded ? '' : 'checked'}
                           aria-label="Include ${esc(p.workoutName)}">
                    <span class="aip-name">${esc(p.workoutName)}</span>
                </label>
                <span>${p.durationMin} min · TSS ${p.tss}${p.hard ? ' · hard' : ''}${p.source === 'custom' ? ' · <span class="ai-chip">custom</span>' : ''}</span>
                ${graphSVG(p.workout, {maxPower: 1.5})}
                ${p.notes ? `<span class="ai-muted">${esc(p.notes)}</span>` : ''}
                ${p.warnings.map((w) => `<span class="aip-warn">${esc(w)}</span>`).join('')}
            </div>`;
    }
    renderPreview() {
        const pv = session.preview;
        const saving = session.status === 'saving';
        const byDate = new Map();
        pv.entries.forEach((p) => byDate.set(p.date, (byDate.get(p.date) ?? []).concat(p)));
        const existing = new Map();
        pv.existing.forEach((e) => existing.set(e.date, (existing.get(e.date) ?? []).concat(e)));

        const weeks = [];
        for(let i = 0; i < pv.days.length; i += 7) weeks.push(pv.days.slice(i, i + 7));
        const count = pv.entries.filter((p) => p.include !== false).length;

        return `
            <div class="ai-card">
                <h3>Proposed plan</h3>
                ${pv.summary ? `<p style="margin:0">${esc(pv.summary)}</p>` : ''}
                ${pv.weeklyFocus.length ? `<div class="ai-row">${pv.weeklyFocus.map((x, i) => `<span class="ai-chip">W${i + 1}: ${esc(x)}</span>`).join('')}</div>` : ''}
                ${pv.warnings.map((w) => `<p class="ai-warning" style="margin:0">${esc(w)}</p>`).join('')}
            </div>
            ${weeks.map((days, wi) => {
                const t = blockTotals(pv.entries.filter((p) => days.some((d) => d.date === p.date)));
                return `
                <div class="ai-card">
                    <div class="aip-week-head">
                        <span>Week ${wi + 1} · from ${esc(dayLabel(days[0].date))}</span>
                        <span class="ai-muted">${t ? `${t.count} rides · ${hours(t.minutes)} · TSS ${t.tss}` : 'no rides'}</span>
                    </div>
                    <div class="aip-week">
                        ${days.map((d) => {
                            const sessions = byDate.get(d.date) ?? [];
                            const ex = existing.get(d.date) ?? [];
                            const empty = sessions.length === 0 && ex.length === 0;
                            return `
                            <div class="aip-day ${d.available ? '' : 'off'} ${empty ? 'empty' : ''}">
                                <span class="aip-day-date">${esc(dayLabel(d.date))}</span>
                                ${ex.map((e) => `<span class="aip-existing">Planned: ${esc(e.workoutName)}${e.status !== 'planned' ? ` (${esc(e.status)})` : ''}</span>`).join('')}
                                ${sessions.map((p) => this.renderSession(p)).join('')}
                                ${empty ? `<span class="ai-muted">${d.available ? 'Rest' : '—'}</span>` : ''}
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }).join('')}
            <div class="ai-row">
                <button class="ai-btn primary" data-action="accept" ${count && !saving ? '' : 'disabled'}>
                    ${saving ? 'Saving…' : `Accept & schedule ${count} ride${count === 1 ? '' : 's'}`}
                </button>
                <button class="ai-btn" data-action="regenerate" ${saving ? 'disabled' : ''}>Try again</button>
                <button class="ai-btn" data-action="back" ${saving ? 'disabled' : ''}>Edit inputs</button>
            </div>
            <p class="ai-muted">Suggested by ${esc(pv.model)}. Training guidance only, not medical advice.</p>`;
    }
    renderDone() {
        const o = session.outcome ?? {};
        const placed = (o.scheduled ?? []).filter((r) => r.time);
        const unplaced = (o.scheduled ?? []).filter((r) => !r.time);
        return `
            <div class="ai-card">
                <h3>Added ${o.added ?? 0} ride${o.added === 1 ? '' : 's'} to “${esc(o.plan?.name)}”</h3>
                ${placed.length ? `<div class="ai-row">${placed.map((r) => `<span class="ai-chip">${esc(dayLabel(r.date))} ${esc(r.time)}${r.shiftedDays ? ' (moved)' : ''}</span>`).join('')}</div>` : ''}
                ${unplaced.length ? `<p class="aip-warn">${unplaced.length} ride(s) had no free slot in your calendar windows; they keep their day without a time.</p>` : ''}
                ${o.synced ? '<p style="margin:0">Synced to Google Calendar — just show up and ride.</p>' : `
                    <p class="ai-muted" style="margin:0">Google Calendar is not connected. Add the rides to your calendar with an .ics file, or connect Google in Settings → Calendar.</p>
                    <div class="ai-row">
                        <button class="ai-btn primary" data-action="ics" data-open="true">Open in Calendar</button>
                        <button class="ai-btn" data-action="ics" data-open="false">Download .ics</button>
                        <button class="ai-btn" data-action="calendar-settings">Calendar settings</button>
                    </div>`}
                <div class="ai-row"><button class="ai-btn" data-action="again">Plan again</button></div>
            </div>`;
    }
    render() {
        let body;
        if(session.status === 'done') body = this.renderDone();
        else if((session.status === 'preview' || session.status === 'saving') && session.preview) body = this.renderPreview();
        else body = this.renderForm();
        this.innerHTML = `
            <div class="aip">
                <h3>Plan my week(s)</h3>
                ${body}
                ${session.error ? `<p class="ai-error">${esc(session.error)}</p>` : ''}
            </div>`;
    }
}

// ----------------------------------------------------------------------------
// <x-ai-plan-changes data-activity-id="…">
// ----------------------------------------------------------------------------

const proposals = new Map(); // activityId -> {status, result, error, outcome}

function proposal(id) {
    if(!proposals.has(id)) proposals.set(id, {status: 'idle'});
    return proposals.get(id);
}

async function loadFeedback(activityId) {
    const record = await idb.get('activity', activityId);
    return record?.analysis?.feedback ?? null;
}

function fmtSide(x) {
    if(!x) return '';
    if(x.minutes === 0 && x.name === 'Rest') return 'Rest';
    return `${esc(dayLabel(x.date))} · ${esc(x.name)} · ${x.minutes ?? '?'} min${x.tss !== null && x.tss !== undefined ? ` · TSS ${x.tss}` : ''}`;
}

class AiPlanChanges extends HTMLElement {
    connectedCallback() {
        injectPlannerStyle();
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.addEventListener('click', this.onClick.bind(this), signal);
        xf.sub('ai:planner:state', () => this.render(), signal);
        this.render();
    }
    disconnectedCallback() {
        this.abortController?.abort();
    }
    get activityId() {
        return this.dataset.activityId;
    }
    async onClick(e) {
        const btn = e.target.closest('[data-action]');
        if(!btn || !this.contains(btn)) return;
        const p = proposal(this.activityId);
        const action = btn.dataset.action;
        if(action === 'propose') {
            p.status = 'busy';
            p.error = '';
            notify();
            try {
                const feedback = await loadFeedback(this.activityId);
                if(!feedback) throw new Error('Get coach feedback for this ride first.');
                p.result = await proposeChanges({feedback});
                p.status = 'ready';
            } catch(err) {
                console.error(':ai :plan-changes', err);
                p.error = err.message ?? String(err);
                p.status = 'idle';
            }
            notify();
        } else if(action === 'select') {
            const c = p.result?.changes.find((x) => x.id === btn.dataset.id);
            if(c) c.selected = btn.checked;
            notify();
        } else if(action === 'apply') {
            p.status = 'applying';
            notify();
            try {
                p.outcome = await applyChanges(p.result.changes);
                p.outcome.count = p.result.changes.filter((c) => c.selected !== false).length;
                p.status = 'applied';
            } catch(err) {
                console.error(':ai :plan-changes :apply', err);
                p.error = err.message ?? String(err);
                p.status = 'ready';
            }
            notify();
        } else if(action === 'discard') {
            proposals.delete(this.activityId);
            notify();
        } else if(action === 'ics') {
            exportIcs({open: btn.dataset.open === 'true'});
        }
    }
    renderChanges(p) {
        const r = p.result;
        const applying = p.status === 'applying';
        const count = r.changes.filter((c) => c.selected !== false).length;
        return `
            ${r.summary ? `<p style="margin:0">${esc(r.summary)}</p>` : ''}
            ${r.changes.length === 0 ? '<p class="ai-muted">No changes to your upcoming plan.</p>' : ''}
            ${r.changes.map((c) => `
                <label class="aip-change">
                    <input type="checkbox" data-action="select" data-id="${esc(c.id)}" ${c.selected !== false ? 'checked' : ''} ${applying ? 'disabled' : ''}>
                    <span class="aip-diff-wrap">
                        <b>${esc(c.label)}</b> <span class="ai-muted">${esc(c.planName ?? '')}</span>
                        <span class="aip-diff"><span class="aip-before">${fmtSide(c.before)}</span> → <span>${fmtSide(c.after)}</span></span>
                        ${c.reason ? `<span class="ai-muted">${esc(c.reason)}</span>` : ''}
                        ${c.warnings.map((w) => `<span class="aip-warn"> ${esc(w)}</span>`).join('')}
                    </span>
                </label>`).join('')}
            ${r.warnings.map((w) => `<p class="aip-warn" style="margin:0">${esc(w)}</p>`).join('')}
            <div class="ai-row">
                ${r.changes.length ? `<button class="ai-btn primary" data-action="apply" ${count && !applying ? '' : 'disabled'}>
                    ${applying ? 'Applying…' : `Apply ${count} change${count === 1 ? '' : 's'}`}</button>` : ''}
                <button class="ai-btn" data-action="discard" ${applying ? 'disabled' : ''}>Discard</button>
            </div>`;
    }
    renderApplied(p) {
        const o = p.outcome ?? {};
        return `
            <p style="margin:0">Applied ${o.count ?? 0} change${o.count === 1 ? '' : 's'} to your plan.</p>
            ${o.synced ? '<p class="ai-muted" style="margin:0">Calendar re-synced.</p>' : (o.needsIcs ? `
                <div class="ai-row">
                    <button class="ai-btn" data-action="ics" data-open="true">Update calendar (.ics)</button>
                </div>` : '')}`;
    }
    render() {
        if(!this.activityId) { this.innerHTML = ''; return; }
        const p = proposal(this.activityId);
        let body = '';
        if(p.status === 'applied') body = this.renderApplied(p);
        else if((p.status === 'ready' || p.status === 'applying') && p.result) body = this.renderChanges(p);
        else body = `
            <button class="ai-btn primary" data-action="propose" ${p.status === 'busy' || !isConfigured() ? 'disabled' : ''}>
                ${p.status === 'busy' ? 'Asking Claude…' : 'Turn into plan changes'}
            </button>
            <span class="ai-muted">Claude proposes concrete changes to your next two weeks; you pick which to apply.</span>`;
        this.innerHTML = `
            <div class="aip ai-card">
                <b>Adjust my plan</b>
                ${body}
                ${p.error ? `<p class="ai-error">${esc(p.error)}</p>` : ''}
            </div>`;
    }
}

customElements.define('x-ai-planner', AiPlanner);
customElements.define('x-ai-plan-changes', AiPlanChanges);

export { AiPlanner, AiPlanChanges, session, proposals };
