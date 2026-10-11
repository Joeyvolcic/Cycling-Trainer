// Readiness check orchestration: gather context -> ask Claude -> deterministic
// adjustment -> rider accepts/rejects -> log.
import { xf } from '../../functions.js';
import { models } from '../../models/models.js';
import { zwo } from '../../workouts/zwo.js';
import { entriesForDate, updateEntry, resolveWorkout } from '../plans/plans.js';
import { complete, isConfigured, getModel } from './claude.js';
import { getWellness, getRecentLoad, getIntervalsPlanned, isoDate } from './wellness.js';
import {
    DECISION_SCHEMA, SYSTEM_PROMPT, buildPrompt, summarizeWorkout,
    sanitizeDecision, applyDecision, workoutMetrics,
} from './adjust.js';
import { adjustedEntryPatch } from './planner-core.js';

const LOG_STORAGE = 'ai:readiness-log';
const LOG_CAPACITY = 60;

// Live app state mirrored from the db store (module is imported before app:start)
const state = {
    ftp: 200,
    workout: undefined,
    workouts: [],
    activity: [],
};
xf.sub('db:ftp', (x) => { state.ftp = x; });
xf.sub('db:workout', (x) => { state.workout = x; });
xf.sub('db:workouts', (x) => { state.workouts = x ?? []; });
xf.sub('db:activity', (x) => { state.activity = x ?? []; });

// library by id, then by name, then the entry's own snapshot (plans.resolveWorkout)
function findInLibrary(entry) {
    return resolveWorkout(entry, state.workouts ?? []);
}

// -> [{key, label, source, workout, entry?}]
async function getCandidates(date = isoDate()) {
    const out = [];

    try {
        const entries = await entriesForDate(date);
        for(const entry of entries ?? []) {
            if(entry.status && entry.status !== 'planned') continue;
            const workout = findInLibrary(entry);
            if(workout) {
                out.push({
                    key: `plan:${entry.planId ?? ''}:${entry.id}`,
                    label: entry.workoutName ?? workout.meta?.name,
                    source: 'Training plan',
                    workout,
                    entry,
                });
            }
        }
    } catch(e) {
        console.warn(':ai :readiness :plans', e);
    }

    try {
        for(const w of models.planned.list() ?? []) {
            if((w.meta?.startDateLocal ?? '').slice(0, 10) === date) {
                out.push({key: `planned:${w.id}`, label: w.meta?.name, source: 'intervals.icu', workout: w});
            }
        }
    } catch(e) {
        console.warn(':ai :readiness :planned', e);
    }

    if(!out.some((c) => c.source === 'intervals.icu')) {
        try {
            for(const ev of await getIntervalsPlanned(date)) {
                const w = zwo.readToInterval(atob(ev.workout_file_base64));
                w.id = `icu-${ev.id}`;
                w.intervals_id = ev.id;
                w.meta.name = w.meta.name || ev.name;
                w.meta.planned = true;
                w.meta.startDateLocal = ev.start_date_local;
                out.push({key: `icu:${ev.id}`, label: w.meta.name, source: 'intervals.icu', workout: w});
            }
        } catch(e) {
            console.warn(':ai :readiness :intervals-planned', e);
        }
    }

    if(state.workout?.intervals && !out.some((c) => c.workout.id === state.workout.id)) {
        out.push({
            key: `current:${state.workout.id ?? 'selected'}`,
            label: state.workout.meta?.name ?? 'Selected workout',
            source: 'Selected workout',
            workout: state.workout,
        });
    }

    return out;
}

async function checkReadiness({workout, date = isoDate()} = {}) {
    if(!isConfigured()) throw new Error('AI is not configured.');
    if(!workout?.intervals?.length) throw new Error('No workout to check.');

    const [wellness, load] = await Promise.all([
        getWellness(date),
        getRecentLoad(date, {localActivities: state.activity}),
    ]);

    const workoutSummary = summarizeWorkout(workout, state.ftp);

    const raw = await complete({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt({date, workoutSummary, wellness, load}),
        json: true,
        schema: DECISION_SCHEMA,
        effort: 'medium',
        maxTokens: 16000,
    });

    const decision = sanitizeDecision(raw, workout);
    const adjusted = applyDecision(workout, decision);

    return {
        id: `${date}-${Date.now()}`,
        date,
        model: getModel(),
        wellness,
        load,
        workoutSummary,
        decision,
        original: workout,
        adjusted,
        before: workoutMetrics(workout),
        after: adjusted ? workoutMetrics(adjusted) : null,
    };
}

function getLog() {
    try {
        return JSON.parse(localStorage.getItem(LOG_STORAGE) ?? '[]');
    } catch(e) {
        return [];
    }
}

function logDecision(result, outcome) {
    const entry = {
        id: result.id,
        date: result.date,
        at: new Date().toISOString(),
        model: result.model,
        workout: result.workoutSummary?.name,
        decision: result.decision,
        outcome, // 'accepted' | 'rejected'
        before: result.before && {minutes: result.before.minutes, tss: result.before.tss, if: result.before.if},
        after: result.after && {minutes: result.after.minutes, tss: result.after.tss, if: result.after.if},
        wellness: result.wellness,
    };
    const log = [entry].concat(getLog()).slice(0, LOG_CAPACITY);
    try {
        localStorage.setItem(LOG_STORAGE, JSON.stringify(log));
    } catch(e) {
        console.warn(':ai :readiness :log', e);
    }
    xf.dispatch('ai:readiness:logged', entry);
    return entry;
}

// Rider accepted: the adjusted copy is saved to the library as a custom
// workout (meta.adjustedFrom = original id), linked from the plan entry
// (workoutId + snapshot + entry.adjustedFrom) and loaded as the current
// workout, so the ride is matched to the entry and post-ride analysis compares
// against what was actually prescribed. The original stays untouched.
async function acceptResult(result, candidate, {saveToLibrary = true} = {}) {
    const d = result.decision;
    const entry = candidate?.entry;
    const changed = !!result.adjusted && d.decision !== 'keep';
    if(changed && saveToLibrary) {
        try {
            xf.dispatch('ui:workout:save', result.adjusted);
        } catch(e) {
            console.warn(':ai :readiness :library-save', e);
        }
    }
    let linked = false;
    if(entry?.planId && entry.id) {
        const note = `AI readiness: ${d.decision.replace(/_/g, ' ')}` +
              (d.decision === 'rest' ? '' : ` (${result.after?.minutes ?? '?'} min)`) +
              ` — ${d.rationale}`;
        const patch = changed ?
              adjustedEntryPatch(entry, result.adjusted, {by: 'readiness', note, decision: d.decision}) :
              {notes: [entry.notes, note].filter(Boolean).join('\n')};
        if(d.decision === 'rest') patch.status = 'skipped';
        try {
            await updateEntry(entry.planId, entry.id, patch);
            linked = changed;
        } catch(e) {
            console.warn(':ai :readiness :plan-update', e);
        }
    }
    if(result.adjusted) {
        if(linked) {
            // loads the entry's (now adjusted) workout and marks the entry active
            xf.dispatch('ui:plans:ride', {planId: entry.planId, entryId: entry.id});
        } else {
            xf.dispatch('workout', changed ? result.adjusted : result.original);
        }
    }
    return logDecision(result, 'accepted');
}

function rejectResult(result) {
    return logDecision(result, 'rejected');
}

export {
    state,
    getCandidates,
    checkReadiness,
    acceptResult,
    rejectResult,
    getLog,
};
