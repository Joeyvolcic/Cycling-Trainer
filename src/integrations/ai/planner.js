// AI plan builder + coach-feedback plan changes: orchestration.
//
//   proposePlan(form)            -> preview      (Claude picks sessions; validated in planner-core)
//   acceptPlan(preview, opts)    -> {plan, scheduled, synced, needsIcs}
//   proposeChanges({feedback})   -> {summary, changes, warnings}
//   applyChanges(changes)        -> {plans, synced, needsIcs}
//   saveAdjustedWorkout(workout) -> library copy (custom workout)
//
// Writes go through the plans module (one savePlan per plan), then the calendar
// module picks times (scheduleEntries) and syncs to Google when connected.
import { xf } from '../../functions.js';
import {
    listPlans, getPlan, savePlan, createPlan, todayISO, weekStart, addDays,
} from '../plans/plans.js';
import { scheduleEntries, syncAll, exportIcs, loadPrefs } from '../calendar/calendar.js';
import * as google from '../calendar/google.js';
import { complete, isConfigured, getModel } from './claude.js';
import { getWellness, getRecentLoad } from './wellness.js';
import { state } from './readiness.js';
import {
    buildCatalog, availabilityFromPrefs, planningDays, buildPlanPrompt, validatePlan,
    mergePlanEntries, upcomingEntries, buildChangesPrompt, validateChanges,
    applyChangesToEntries, PLAN_SCHEMA, PLAN_SYSTEM_PROMPT, CHANGES_SCHEMA,
    CHANGES_SYSTEM_PROMPT,
} from './planner-core.js';

const GOALS = [
    {id: 'ftp', label: 'Raise FTP'},
    {id: 'endurance', label: 'Build endurance'},
    {id: 'event', label: 'Prepare for an event'},
    {id: 'maintain', label: 'Maintain fitness'},
    {id: 'comeback', label: 'Return after a break'},
];

function googleConnected() {
    try { return google.isConfigured() && google.isConnected(); } catch(e) { return false; }
}

function defaultStartDate(today = todayISO()) {
    // this week's remaining days are rarely worth planning on a Sunday
    const monday = weekStart(today);
    return new Date().getDay() === 0 ? addDays(monday, 7) : today;
}

// defaults for the planner form, from calendar prefs + app state
function defaultForm() {
    const {days, minutesByWeekday} = availabilityFromPrefs(loadPrefs());
    const weekday = Math.max(0, ...[1, 2, 3, 4, 5].map((d) => minutesByWeekday[d] ?? 0));
    const weekend = Math.max(0, ...[0, 6].map((d) => minutesByWeekday[d] ?? 0));
    const weekly = days.reduce((acc, d) => acc + Math.min(minutesByWeekday[d], 90), 0) / 60;
    return {
        goal: 'ftp',
        goalDetails: '',
        eventDate: '',
        startDate: defaultStartDate(),
        weeks: 1,
        days: days.length ? days : [2, 4, 6],
        weekdayMinutes: weekday || 60,
        weekendMinutes: weekend || 120,
        weeklyHours: Math.max(2, Math.round(weekly * 2) / 2) || 5,
        ftp: state.ftp,
        planId: '',
        replaceExisting: false,
    };
}

async function gatherContext(form) {
    const today = todayISO();
    const startDate = form.startDate && form.startDate >= today ? form.startDate : today;
    const weeks = Math.min(4, Math.max(1, Number(form.weeks) || 1));
    const minutesByWeekday = {};
    for(let d = 0; d < 7; d++) {
        minutesByWeekday[d] = (d === 0 || d === 6) ? Number(form.weekendMinutes) || 0 : Number(form.weekdayMinutes) || 0;
    }
    const days = planningDays({startDate, weeks, availableDays: (form.days ?? []).map(Number), minutesByWeekday});
    const from = days[0].date;
    const to = days[days.length - 1].date;

    const plans = await listPlans();
    const existing = plans
        .flatMap((p) => (p.entries ?? []).filter((e) => e.date >= from && e.date <= to)
                 .map((e) => Object.assign({}, e, {planId: p.id})));
    // when replacing, only the target plan's planned entries go away
    const kept = form.replaceExisting && form.planId ?
          existing.filter((e) => e.planId !== form.planId || e.status !== 'planned') :
          existing;

    const [wellness, load] = await Promise.all([
        getWellness(today).catch(() => ({source: 'none'})),
        getRecentLoad(today, {localActivities: state.activity}).catch(() => null),
    ]);
    const {catalog, byRef} = buildCatalog(state.workouts);
    const ftp = Number(form.ftp) > 0 ? Math.round(Number(form.ftp)) : state.ftp;

    return {
        today, startDate, weeks, from, to, days, plans, existing,
        kept, replaceExisting: !!(form.replaceExisting && form.planId),
        wellness, load, catalog, byRef, ftp,
        goal: (GOALS.find((g) => g.id === form.goal)?.label) ?? form.goal,
        goalDetails: form.goalDetails, eventDate: form.eventDate || '',
        weeklyHours: Number(form.weeklyHours) || undefined,
    };
}

async function proposePlan(form, {ai = {complete, isConfigured}} = {}) {
    if(!ai.isConfigured()) throw new Error('Add your Anthropic API key in Settings → AI Coach first.');
    const ctx = await gatherContext(form);
    if(!ctx.days.some((d) => d.available)) throw new Error('Pick at least one available day.');
    if(ctx.catalog.length === 0) throw new Error('Your workout library is still loading. Try again in a moment.');

    const raw = await ai.complete({
        system: PLAN_SYSTEM_PROMPT,
        prompt: buildPlanPrompt({
            today: ctx.today, startDate: ctx.startDate, weeks: ctx.weeks,
            goal: ctx.goal, goalDetails: ctx.goalDetails, eventDate: ctx.eventDate,
            ftp: ctx.ftp, weeklyHours: ctx.weeklyHours, days: ctx.days,
            existing: ctx.kept, replaceExisting: ctx.replaceExisting,
            load: ctx.load, wellness: ctx.wellness, catalog: ctx.catalog,
        }),
        json: true,
        schema: PLAN_SCHEMA,
        effort: 'medium',
        maxTokens: 16000,
    });

    const result = validatePlan(raw, {
        byRef: ctx.byRef, days: ctx.days, existing: ctx.kept,
        replaceExisting: false, // ctx.kept already excludes the entries being replaced
        today: ctx.today, weeklyHours: ctx.weeklyHours,
    });

    return {
        form: Object.assign({}, form),
        model: getModel(),
        from: ctx.from,
        to: ctx.to,
        days: ctx.days,
        existing: ctx.kept,
        replaceExisting: ctx.replaceExisting,
        goal: ctx.goal,
        eventDate: ctx.eventDate,
        ...result,
    };
}

// pick times with the calendar module and store them on the entries
async function scheduleIntoPlan(plan, entryIds) {
    const entries = plan.entries.filter((e) => entryIds.has(e.id));
    if(entries.length === 0) return [];
    let results = [];
    try {
        results = await scheduleEntries(entries);
    } catch(e) {
        console.warn(':ai :planner :schedule', e);
        return [];
    }
    const byId = new Map(results.map((r) => [r.entryId, r]));
    plan.entries = plan.entries.map((e) => {
        const r = byId.get(e.id);
        if(!r || !r.time) return e;
        return Object.assign({}, e, {date: r.date, targetTime: r.time});
    });
    return results;
}

async function syncOrIcs() {
    if(googleConnected()) {
        try {
            await syncAll({interactive: false});
            return {synced: true, needsIcs: false};
        } catch(e) {
            console.warn(':ai :planner :sync', e);
        }
    }
    return {synced: false, needsIcs: true};
}

async function acceptPlan(preview, {planId = preview?.form?.planId, planName} = {}) {
    const accepted = (preview?.entries ?? []).filter((e) => e.include !== false);
    if(accepted.length === 0) throw new Error('Nothing selected to add.');

    let plan = planId ? await getPlan(planId) : undefined;
    if(!plan) {
        plan = await createPlan({
            name: planName || `AI plan from ${preview.from}`,
            description: preview.summary ?? '',
            goal: [preview.goal, preview.eventDate ? `event ${preview.eventDate}` : ''].filter(Boolean).join(' · '),
            startDate: weekStart(preview.from),
            entries: [],
        });
    }
    const before = new Set((plan.entries ?? []).map((e) => e.id));
    plan.entries = mergePlanEntries(plan.entries, accepted, {
        replaceExisting: preview.replaceExisting && plan.id === preview.form?.planId,
        from: preview.from, to: preview.to,
    });
    plan = await savePlan(plan); // assigns ids
    const added = new Set(plan.entries.filter((e) => !before.has(e.id)).map((e) => e.id));

    const scheduled = await scheduleIntoPlan(plan, added);
    plan = await savePlan(plan);

    const sync = await syncOrIcs();
    xf.dispatch('ai:planner:accepted', {planId: plan.id, count: added.size});
    return {plan, added: added.size, scheduled, ...sync};
}

// ----------------------------------------------------------------------------
// Coach feedback -> plan changes
// ----------------------------------------------------------------------------

async function proposeChanges({feedback, today = todayISO(), horizonDays = 14} = {}, {ai = {complete, isConfigured}} = {}) {
    if(!ai.isConfigured()) throw new Error('Add your Anthropic API key in Settings → AI Coach first.');
    const plans = await listPlans();
    const upcoming = upcomingEntries(plans, {today, horizonDays});
    if(upcoming.length === 0) {
        return {summary: 'No planned sessions in the next two weeks to adjust.', changes: [], warnings: [], empty: true};
    }
    const {catalog, byRef} = buildCatalog(state.workouts);
    const raw = await ai.complete({
        system: CHANGES_SYSTEM_PROMPT,
        prompt: buildChangesPrompt({today, ftp: state.ftp, feedback, upcoming, workouts: state.workouts, catalog}),
        json: true,
        schema: CHANGES_SCHEMA,
        effort: 'medium',
        maxTokens: 8000,
    });
    return Object.assign(
        validateChanges(raw, {upcoming, byRef, workouts: state.workouts, today}),
        {model: getModel()},
    );
}

async function applyChanges(changes = []) {
    const selected = changes.filter((c) => c.selected !== false);
    if(selected.length === 0) return {plans: [], synced: false, needsIcs: false};
    const at = new Date().toISOString();
    const byPlan = new Map();
    selected.forEach((c) => byPlan.set(c.planId, (byPlan.get(c.planId) ?? []).concat(c)));

    const saved = [];
    for(const [planId, list] of byPlan) {
        let plan = await getPlan(planId);
        if(!plan) continue;
        plan.entries = applyChangesToEntries(plan.entries, list, {at});
        const moved = new Set(list.filter((c) => c.action === 'move').map((c) => c.entryId));
        if(moved.size) await scheduleIntoPlan(plan, moved);
        saved.push(await savePlan(plan));
    }
    const sync = await syncOrIcs();
    xf.dispatch('ai:plan-changes:applied', {count: selected.length});
    return {plans: saved, ...sync};
}

// ----------------------------------------------------------------------------
// Library
// ----------------------------------------------------------------------------

// store an AI-adjusted workout as a custom library workout (library.js upsert)
function saveAdjustedWorkout(workout) {
    if(!workout?.intervals) return workout;
    xf.dispatch('ui:workout:save', workout);
    return workout;
}

export {
    GOALS,
    googleConnected,
    defaultForm,
    gatherContext,
    proposePlan,
    acceptPlan,
    proposeChanges,
    applyChanges,
    saveAdjustedWorkout,
    exportIcs,
};
