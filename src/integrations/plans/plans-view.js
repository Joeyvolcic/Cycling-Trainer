//
// <plans-view> Training plans UI on the workouts page
//
// Touch first (44px targets, no hover-only UI). Create/edit/delete plans, add library
// workouts to a date, reorder/move entries, mark done/skipped, duplicate a week,
// import/export a plan as JSON, and ride today's entry.
//

import { xf } from '../../functions.js';
import { models } from '../../models/models.js';
import { fileHandler } from '../../file.js';
import {
    listPlans, savePlan, deletePlan, createPlan, updateEntry, addWorkout,
    removeEntry, moveEntry, reorderEntry, duplicateWeek, exportPlan, importPlan,
    todayISO, addDays, weekStart, parsePlanJSON,
} from './plans.js';
import { getActive } from './today.js';

const SELECTED_KEY = 'plans:selected';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function dayLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return {
        weekDay: date.toLocaleString(undefined, {weekday: 'short'}),
        day: date.toLocaleString(undefined, {month: 'short', day: 'numeric'}),
    };
}

function readSelected() {
    try { return window.localStorage.getItem(SELECTED_KEY); } catch(_) { return null; }
}

function writeSelected(id) {
    try { window.localStorage.setItem(SELECTED_KEY, id ?? ''); } catch(_) {}
}

const styles = `
plans-view { display: block; }
plans-view .plans--bar { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; margin-bottom: 1em; }
plans-view .plans--bar select { flex: 1 1 12em; }
plans-view button, plans-view select, plans-view input, plans-view textarea {
    min-height: 44px; font: inherit; color: var(--foreground-color, #fff);
    background: var(--chrome, #35363a); border: 1px solid var(--border-color, #fff2);
    border-radius: 0.4em; padding: 0 0.9em; touch-action: manipulation;
}
plans-view textarea { padding: 0.6em 0.9em; min-height: 4em; width: 100%; box-sizing: border-box; }
plans-view button { cursor: pointer; min-width: 44px; }
plans-view button.primary { background: var(--zone-blue, #328AFF); color: #fff; border-color: transparent; }
plans-view button.danger { color: var(--red, #FF495F); }
plans-view button:disabled { opacity: 0.4; }
plans-view .plans--empty, plans-view .plans--note { color: var(--gray, #aaa); padding: 0.5em 0; }
plans-view .plans--panel { border: 1px solid var(--border-color, #fff2); border-radius: 0.6em; padding: 1em; margin-bottom: 1em; }
plans-view .plans--form { display: grid; gap: 0.75em; }
plans-view .plans--form label { display: grid; gap: 0.3em; color: var(--gray, #aaa); }
plans-view .plans--row { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; }
plans-view .plans--today { border-color: var(--zone-blue, #328AFF); }
plans-view .plans--week-nav { display: flex; gap: 0.5em; align-items: center; justify-content: space-between; margin: 1em 0 0.5em; flex-wrap: wrap; }
plans-view .plans--week-title { flex: 1; text-align: center; font-weight: bold; }
plans-view .plans--day { display: grid; grid-template-columns: 4.5em 1fr; gap: 0.75em; padding: 0.6em 0; border-top: 1px solid var(--border-color, #fff2); }
plans-view .plans--day.is-today .plans--day-label { color: var(--zone-blue, #328AFF); }
plans-view .plans--day-label { display: grid; align-content: start; }
plans-view .plans--day-label .wd { font-weight: bold; text-transform: uppercase; font-size: 0.9em; }
plans-view .plans--day-label .d { color: var(--gray, #aaa); font-size: 0.85em; }
plans-view .plans--entries { display: grid; gap: 0.5em; }
plans-view .plan-entry { border-radius: 0.5em; padding: 0.5em 0.6em; background: var(--white-opacity-01, #ffffff10); border-left: 4px solid var(--zone-gray, #636468); }
plans-view .plan-entry.status-done { border-left-color: var(--zone-green, #57C057); }
plans-view .plan-entry.status-skipped { border-left-color: var(--zone-orange, #FF663A); opacity: 0.7; }
plans-view .plan-entry.is-active { outline: 2px solid var(--zone-blue, #328AFF); }
plans-view .plan-entry--head { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; justify-content: space-between; }
plans-view .plan-entry--name { font-weight: bold; }
plans-view .plan-entry--meta { color: var(--gray, #aaa); font-size: 0.9em; }
plans-view .plan-entry--notes { color: var(--gray, #aaa); font-size: 0.9em; margin-top: 0.3em; white-space: pre-wrap; }
plans-view .plan-entry--actions { display: flex; flex-wrap: wrap; gap: 0.4em; margin-top: 0.4em; }
plans-view .plan-entry--more { display: grid; gap: 0.6em; margin-top: 0.6em; }
plans-view .badge { font-size: 0.8em; text-transform: uppercase; padding: 0.2em 0.6em; border-radius: 1em; background: var(--zone-gray, #636468); color: #fff; }
plans-view .badge.done { background: var(--zone-green, #57C057); }
plans-view .badge.skipped { background: var(--zone-orange, #FF663A); }
plans-view .plans--add-day { justify-self: start; }
plans-view input[type=file] { display: none; }
.editor--status { align-self: center; margin-left: 1em; color: var(--green, #40FF70); }
.workout--lib-actions { display: flex; flex-wrap: wrap; gap: 0.5em; padding: 0.5em 0 1em; }
.workout--lib-actions .lib-btn { min-height: 44px; min-width: 44px; padding: 0 1em; font: inherit; cursor: pointer;
    color: var(--foreground-color, #fff); background: var(--chrome, #35363a);
    border: 1px solid var(--border-color, #fff2); border-radius: 0.4em; touch-action: manipulation; }
`;

function injectStyles() {
    if(document.getElementById('plans-view-styles')) return;
    const $style = document.createElement('style');
    $style.id = 'plans-view-styles';
    $style.textContent = styles;
    document.head.appendChild($style);
}

class PlansView extends HTMLElement {
    constructor() {
        super();
        this.plans = [];
        this.planId = readSelected();
        this.week = weekStart(todayISO());
        this.workouts = [];
        this.mode = 'view';       // 'view' | 'plan-form' | 'add'
        this.formPlan = null;     // plan being edited in 'plan-form' (null = new)
        this.addDate = todayISO();
        this.addWorkoutId = null;
        this.expanded = new Set();
    }
    connectedCallback() {
        injectStyles();
        this.abortController = new AbortController();
        this.signal = { signal: this.abortController.signal };

        this.addEventListener('click', this.onClick.bind(this), this.signal);
        this.addEventListener('change', this.onChange.bind(this), this.signal);

        xf.sub('plans:changed', this.reload.bind(this), this.signal);
        xf.sub('plans:active', () => this.render(), this.signal);
        xf.sub('db:workouts', workouts => { this.workouts = workouts ?? []; if(this.mode === 'add') this.render(); }, this.signal);
        xf.sub('action:planned', () => this.render(), this.signal); // intervals.icu data changed
        xf.sub('ui:plans:add-workout', this.onAddWorkoutRequest.bind(this), this.signal);
        xf.sub('workout:restore', () => this.reload(), this.signal);

        this.render();
    }
    disconnectedCallback() {
        this.abortController.abort();
    }

    // state
    get plan() {
        return this.plans.find(p => p.id === this.planId);
    }
    async reload() {
        try {
            this.plans = await listPlans();
        } catch(err) {
            console.error(':plans-view :reload', err);
            this.plans = [];
        }
        if(!this.plan && this.plans.length > 0) {
            this.selectPlan(this.plans[0].id, false);
        }
        this.render();
    }
    selectPlan(id, render = true) {
        this.planId = id;
        writeSelected(id);
        const plan = this.plan;
        if(plan) {
            const today = todayISO();
            this.week = today >= plan.startDate ? weekStart(today) : weekStart(plan.startDate);
        }
        this.expanded.clear();
        if(render) this.render();
    }
    findEntry(entryId) {
        return this.plan?.entries.find(e => e.id === entryId);
    }
    async ensurePlan() {
        if(this.plan) return this.plan;
        const plan = await createPlan({name: 'My plan', startDate: weekStart(todayISO())});
        this.plans = await listPlans();
        this.selectPlan(plan.id, false);
        return plan;
    }

    // events
    onAddWorkoutRequest(workoutId) {
        this.addWorkoutId = workoutId;
        this.addDate = todayISO();
        this.mode = 'add';
        this.render();
        this.scrollIntoView({behavior: 'smooth', block: 'start'});
    }
    async onClick(e) {
        const $btn = e.target.closest('[data-action]');
        if(!$btn || !this.contains($btn)) return;
        const action = $btn.dataset.action;
        const entryId = $btn.closest('[data-entry]')?.dataset.entry;
        const plan = this.plan;

        try {
            switch(action) {
            case 'new-plan':
                this.formPlan = null; this.mode = 'plan-form'; this.render(); break;
            case 'edit-plan':
                if(plan) { this.formPlan = plan; this.mode = 'plan-form'; this.render(); } break;
            case 'cancel':
                this.mode = 'view'; this.render(); break;
            case 'save-plan':
                await this.savePlanForm(); break;
            case 'delete-plan':
                if(plan && window.confirm(`Delete plan "${plan.name}"?`)) {
                    await deletePlan(plan.id);
                    this.planId = null;
                    this.mode = 'view';
                }
                break;
            case 'export-plan':
                if(plan) {
                    const name = plan.name.replace(/[\\/:*?"<>|]+/g, '_') || 'plan';
                    fileHandler.download()(exportPlan(plan), `${name}.plan.json`, 'application/json');
                }
                break;
            case 'import-plan':
                this.querySelector('.plans--import')?.click(); break;
            case 'prev-week':
                this.week = addDays(this.week, -7); this.render(); break;
            case 'next-week':
                this.week = addDays(this.week, 7); this.render(); break;
            case 'this-week':
                this.week = weekStart(todayISO()); this.render(); break;
            case 'duplicate-week':
                if(plan) {
                    await duplicateWeek(plan.id, this.week);
                    this.week = addDays(this.week, 7);
                }
                break;
            case 'add':
                this.addDate = $btn.dataset.date ?? todayISO();
                this.mode = 'add';
                this.render();
                break;
            case 'confirm-add':
                await this.confirmAdd(); break;
            case 'ride':
                xf.dispatch('ui:plans:ride', {planId: plan.id, entryId}); break;
            case 'today-ride':
                xf.dispatch('ui:plans:ride', {planId: $btn.dataset.planId, entryId: $btn.dataset.entryId}); break;
            case 'ride-intervals':
                xf.dispatch(`action:li:${$btn.dataset.wid}`, ':select');
                xf.dispatch('action:nav', 'home');
                break;
            case 'done': {
                const entry = this.findEntry(entryId);
                await updateEntry(plan.id, entryId, {status: entry?.status === 'done' ? 'planned' : 'done'});
                break;
            }
            case 'skip': {
                const entry = this.findEntry(entryId);
                await updateEntry(plan.id, entryId, {status: entry?.status === 'skipped' ? 'planned' : 'skipped'});
                break;
            }
            case 'more':
                if(this.expanded.has(entryId)) this.expanded.delete(entryId); else this.expanded.add(entryId);
                this.render();
                break;
            case 'up':
                await reorderEntry(plan.id, entryId, -1); break;
            case 'down':
                await reorderEntry(plan.id, entryId, +1); break;
            case 'prev-day':
                await moveEntry(plan.id, entryId, addDays(this.findEntry(entryId).date, -1)); break;
            case 'next-day':
                await moveEntry(plan.id, entryId, addDays(this.findEntry(entryId).date, 1)); break;
            case 'remove':
                if(window.confirm('Remove this workout from the plan?')) {
                    this.expanded.delete(entryId);
                    await removeEntry(plan.id, entryId);
                }
                break;
            }
        } catch(err) {
            console.error(`:plans-view :${action}`, err);
        }
    }
    async onChange(e) {
        const $el = e.target;
        if($el.classList.contains('plans--select')) {
            this.selectPlan($el.value);
            return;
        }
        if($el.classList.contains('plans--import')) {
            const file = $el.files?.[0];
            $el.value = '';
            if(!file) return;
            try {
                const text = await file.text();
                parsePlanJSON(text);
                const plan = await importPlan(text);
                this.selectPlan(plan.id);
            } catch(err) {
                console.error(':plans-view :import', err);
                window.alert('Could not import plan: not a valid plan JSON file.');
            }
            return;
        }
        const field = $el.dataset.field;
        const entryId = $el.closest('[data-entry]')?.dataset.entry;
        if(field && entryId && this.plan) {
            try {
                if(field === 'date') {
                    if($el.value) await moveEntry(this.plan.id, entryId, $el.value);
                } else {
                    await updateEntry(this.plan.id, entryId, {[field]: $el.value});
                }
            } catch(err) {
                console.error(':plans-view :field', err);
            }
        }
    }
    async savePlanForm() {
        const $form = this.querySelector('.plans--form');
        const value = name => $form.querySelector(`[name=${name}]`)?.value?.trim() ?? '';
        const data = {
            name: value('name') || 'My plan',
            startDate: value('startDate') || weekStart(todayISO()),
            goal: value('goal'),
            description: value('description'),
        };
        let plan;
        if(this.formPlan) {
            plan = await savePlan(Object.assign({}, this.formPlan, data));
        } else {
            plan = await createPlan(data);
        }
        this.mode = 'view';
        this.plans = await listPlans();
        this.selectPlan(plan.id);
    }
    async confirmAdd() {
        const $form = this.querySelector('.plans--form');
        const workoutId = $form.querySelector('[name=workout]').value;
        const date = $form.querySelector('[name=date]').value || todayISO();
        const targetTime = $form.querySelector('[name=targetTime]').value || undefined;
        const notes = $form.querySelector('[name=notes]').value || '';
        const workout = this.workouts.find(w => w.id === workoutId);
        if(!workout) return;

        const plan = await this.ensurePlan();
        const extra = {notes};
        if(targetTime) extra.targetTime = targetTime;
        await addWorkout(plan.id, stripView(workout), date, extra);
        this.mode = 'view';
        this.addWorkoutId = null;
        this.week = weekStart(date);
        this.render();
    }

    // templates
    render() {
        const plan = this.plan;
        this.innerHTML = `
            ${this.barTemplate(plan)}
            ${this.mode === 'plan-form' ? this.planFormTemplate(this.formPlan) : ''}
            ${this.mode === 'add' ? this.addTemplate() : ''}
            ${this.todayTemplate()}
            ${plan ? this.weekTemplate(plan) : this.emptyTemplate()}
            <input class="plans--import" type="file" accept=".json,application/json" />`;
    }
    barTemplate(plan) {
        const options = this.plans.map(p =>
            `<option value="${esc(p.id)}" ${p.id === this.planId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
        return `<div class="plans--bar">
            ${this.plans.length ? `<select class="plans--select" aria-label="Training plan">${options}</select>` : ''}
            <button type="button" class="primary" data-action="new-plan">New plan</button>
            ${plan ? `<button type="button" data-action="edit-plan">Edit</button>
                      <button type="button" data-action="export-plan">Export</button>` : ''}
            <button type="button" data-action="import-plan">Import</button>
            ${plan ? `<button type="button" class="danger" data-action="delete-plan">Delete</button>` : ''}
        </div>
        ${plan && (plan.goal || plan.description) ? `<div class="plans--note">
            ${plan.goal ? `Goal: ${esc(plan.goal)}` : ''}${plan.goal && plan.description ? ' · ' : ''}${esc(plan.description)}
        </div>` : ''}`;
    }
    planFormTemplate(plan) {
        return `<div class="plans--panel plans--form">
            <label>Name <input name="name" type="text" value="${esc(plan?.name ?? '')}" placeholder="e.g. FTP Build" /></label>
            <label>Start date <input name="startDate" type="date" value="${esc(plan?.startDate ?? weekStart(todayISO()))}" /></label>
            <label>Goal <input name="goal" type="text" value="${esc(plan?.goal ?? '')}" placeholder="e.g. 300W FTP" /></label>
            <label>Description <textarea name="description">${esc(plan?.description ?? '')}</textarea></label>
            <div class="plans--row">
                <button type="button" class="primary" data-action="save-plan">${plan ? 'Save' : 'Create plan'}</button>
                <button type="button" data-action="cancel">Cancel</button>
            </div>
        </div>`;
    }
    addTemplate() {
        const workouts = this.workouts.length ? this.workouts : (models.workouts.default ?? []);
        if(!this.workouts.length) this.workouts = workouts;
        const options = workouts.map(w => {
            const minutes = w.meta?.duration ? ` (${Math.round(w.meta.duration / 60)} min)` : '';
            return `<option value="${esc(w.id)}" ${w.id === this.addWorkoutId ? 'selected' : ''}>${esc(w.meta?.name)}${minutes}</option>`;
        }).join('');
        return `<div class="plans--panel plans--form">
            <strong>Add workout${this.plan ? ` to "${esc(this.plan.name)}"` : ' (creates "My plan")'}</strong>
            <label>Workout <select name="workout">${options}</select></label>
            <label>Date <input name="date" type="date" value="${esc(this.addDate)}" /></label>
            <label>Time (optional) <input name="targetTime" type="time" value="" /></label>
            <label>Notes <textarea name="notes"></textarea></label>
            <div class="plans--row">
                <button type="button" class="primary" data-action="confirm-add">Add</button>
                <button type="button" data-action="cancel">Cancel</button>
            </div>
        </div>`;
    }
    todayTemplate() {
        const today = todayISO();
        const entries = this.plans.flatMap(p => p.entries
            .filter(e => e.date === today)
            .map(e => Object.assign({}, e, {planId: p.id, planName: p.name})));
        const intervals = (models.planned?.list?.() ?? [])
            .filter(w => w.meta?.startDateLocal && w.meta.startDateLocal.slice(0, 10) === today);

        if(!entries.length && !intervals.length) return '';

        const local = entries.map(e => `
            <div class="plans--row" data-plan="${esc(e.planId)}">
                <span><strong>${esc(e.workoutName)}</strong>
                    <span class="plan-entry--meta">${e.durationMin ? `${e.durationMin} min` : ''}${e.targetTime ? ` · ${esc(e.targetTime)}` : ''} · ${esc(e.planName)}</span></span>
                <span class="badge ${esc(e.status)}">${esc(e.status)}</span>
                ${e.status === 'planned' ? `<button type="button" class="primary" data-action="today-ride" data-plan-id="${esc(e.planId)}" data-entry-id="${esc(e.id)}">Ride</button>` : ''}
            </div>`).join('');
        const remote = intervals.map(w => `
            <div class="plans--row">
                <span>intervals.icu: <strong>${esc(w.meta.name)}</strong></span>
                <button type="button" data-action="ride-intervals" data-wid="${esc(w.id)}">${entries.length ? 'Ride this instead' : 'Ride'}</button>
            </div>`).join('');

        return `<div class="plans--panel plans--today">
            <strong>Today</strong>
            ${local}
            ${remote}
            ${entries.length && intervals.length ? `<div class="plans--note">Your local plan is loaded by default.</div>` : ''}
        </div>`;
    }
    emptyTemplate() {
        return `<div class="plans--empty">No training plan yet. Create one, import a plan JSON, or use
            "Add to plan" on a library workout.</div>`;
    }
    weekTemplate(plan) {
        const today = todayISO();
        const days = Array.from({length: 7}, (_, i) => addDays(this.week, i));
        const end = addDays(this.week, 6);
        const inWeek = plan.entries.filter(e => e.date >= this.week && e.date <= end);
        const done = plan.entries.filter(e => e.status === 'done').length;
        const startLabel = dayLabel(this.week).day;
        const endLabel = dayLabel(end).day;

        return `<div class="plans--note">${done} / ${plan.entries.length} workouts done</div>
        <div class="plans--week-nav">
            <button type="button" data-action="prev-week" aria-label="Previous week">&#9664;</button>
            <span class="plans--week-title">${esc(startLabel)} – ${esc(endLabel)}</span>
            <button type="button" data-action="next-week" aria-label="Next week">&#9654;</button>
        </div>
        <div class="plans--row">
            <button type="button" data-action="this-week">This week</button>
            <button type="button" data-action="duplicate-week" ${inWeek.length ? '' : 'disabled'}>Copy week to next</button>
        </div>
        ${days.map(day => this.dayTemplate(plan, day, today)).join('')}`;
    }
    dayTemplate(plan, day, today) {
        const label = dayLabel(day);
        const entries = plan.entries.filter(e => e.date === day);
        return `<div class="plans--day ${day === today ? 'is-today' : ''}">
            <div class="plans--day-label"><span class="wd">${esc(label.weekDay)}</span><span class="d">${esc(label.day)}</span></div>
            <div class="plans--entries">
                ${entries.map((e, i) => this.entryTemplate(e, i, entries.length)).join('')}
                <button type="button" class="plans--add-day" data-action="add" data-date="${day}" aria-label="Add workout on ${esc(day)}">+ Add</button>
            </div>
        </div>`;
    }
    entryTemplate(e, index, count) {
        const active = getActive();
        const isActive = active && active.entryId === e.id;
        const expanded = this.expanded.has(e.id);
        const meta = [
            e.durationMin ? `${e.durationMin} min` : '',
            e.targetTime ? esc(e.targetTime) : '',
            e.activityId ? 'activity saved' : '',
        ].filter(Boolean).join(' · ');

        return `<div class="plan-entry status-${esc(e.status)} ${isActive ? 'is-active' : ''}" data-entry="${esc(e.id)}">
            <div class="plan-entry--head">
                <span><span class="plan-entry--name">${esc(e.workoutName || 'Workout')}</span>
                    ${meta ? `<span class="plan-entry--meta"> · ${meta}</span>` : ''}</span>
                <span class="badge ${esc(e.status)}">${esc(e.status)}</span>
            </div>
            ${e.notes && !expanded ? `<div class="plan-entry--notes">${esc(e.notes)}</div>` : ''}
            <div class="plan-entry--actions">
                <button type="button" class="primary" data-action="ride">Ride</button>
                <button type="button" data-action="done">${e.status === 'done' ? 'Undo done' : 'Done'}</button>
                <button type="button" data-action="skip">${e.status === 'skipped' ? 'Unskip' : 'Skip'}</button>
                <button type="button" data-action="more" aria-expanded="${expanded}">${expanded ? 'Less' : 'More'}</button>
            </div>
            ${expanded ? `<div class="plan-entry--more">
                <div class="plans--row">
                    <button type="button" data-action="prev-day" aria-label="Move one day earlier">&#9664; Day</button>
                    <button type="button" data-action="next-day" aria-label="Move one day later">Day &#9654;</button>
                    <button type="button" data-action="up" ${index === 0 ? 'disabled' : ''} aria-label="Move up">&#9650;</button>
                    <button type="button" data-action="down" ${index === count - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
                    <button type="button" class="danger" data-action="remove">Remove</button>
                </div>
                <label>Date <input type="date" data-field="date" value="${esc(e.date)}" /></label>
                <label>Time <input type="time" data-field="targetTime" value="${esc(e.targetTime ?? '')}" /></label>
                <label>Notes <textarea data-field="notes">${esc(e.notes)}</textarea></label>
            </div>` : ''}
        </div>`;
    }
}

function stripView(workout) {
    const { graph, selected, ...rest } = workout;
    return rest;
}

customElements.define('plans-view', PlansView);

// <library-tools> buttons next to the workout library: new workout, export custom workouts
class LibraryTools extends HTMLElement {
    connectedCallback() {
        injectStyles();
        this.abortController = new AbortController();
        this.classList.add('workout--lib-actions');
        this.innerHTML = `
            <button type="button" class="lib-btn" data-action="new">New workout</button>
            <button type="button" class="lib-btn" data-action="export-all">Export my workouts (JSON)</button>`;
        this.addEventListener('click', e => {
            const action = e.target.closest('[data-action]')?.dataset.action;
            if(action === 'new') xf.dispatch('ui:workout:new');
            if(action === 'export-all') xf.dispatch('ui:workouts:export-json');
        }, {signal: this.abortController.signal});
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
}

customElements.define('library-tools', LibraryTools);

export { PlansView, LibraryTools };
