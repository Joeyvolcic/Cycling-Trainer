//
// Training plans
//
// Multi-week plans made of dated entries that reference workouts.
// Persisted in the IndexedDB store `plans` (see doc/integrations-contract.md).
//
// TrainingPlan = { id, name, description, startDate: 'YYYY-MM-DD', goal,
//   entries: [{ id, date: 'YYYY-MM-DD', workoutId, workoutName, notes,
//               targetTime?: 'HH:MM', durationMin,
//               status: 'planned'|'done'|'skipped', activityId?, calendarEventId?,
//               workout? /* snapshot {meta, intervals} so the plan is portable */ }] }
//
// Every mutation dispatches the xf event `plans:changed` with
// {action, planId, entryId?}.
//

import { xf } from '../../functions.js';
import { idb } from '../../storage/idb.js';
import { uuid } from '../../storage/uuid.js';

const STORE = 'plans';
const EXPORT_FORMAT = 'auuki-training-plan';
const EXPORT_VERSION = 1;
const STATUSES = ['planned', 'done', 'skipped'];

// in-memory mirror of the store, so sync callers (e.g. the intervals.icu
// "select today's workout" logic) can ask whether a local plan has today covered
const cache = new Map();

//
// Date helpers (local calendar dates as 'YYYY-MM-DD')
//
function pad2(n) {
    return String(n).padStart(2, '0');
}

function toISODate(date = new Date()) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayISO() {
    return toISODate(new Date());
}

function parseISODate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
}

function isISODate(iso) {
    return typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso);
}

function addDays(iso, days) {
    const date = parseISODate(iso);
    date.setDate(date.getDate() + days);
    return toISODate(date);
}

function diffDays(a, b) {
    // whole days from a to b, DST safe
    const ua = Date.UTC(...String(a).split('-').map((x, i) => i === 1 ? Number(x) - 1 : Number(x)));
    const ub = Date.UTC(...String(b).split('-').map((x, i) => i === 1 ? Number(x) - 1 : Number(x)));
    return Math.round((ub - ua) / 86400000);
}

// Monday of the week containing iso
function weekStart(iso = todayISO()) {
    const day = parseISODate(iso).getDay(); // 0 = Sunday
    const offset = day === 0 ? -6 : 1 - day;
    return addDays(iso, offset);
}

//
// Normalization
//
function clone(x) {
    return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

function workoutSnapshot(workout) {
    if(!workout || !Array.isArray(workout.intervals)) return undefined;
    return clone({meta: workout.meta ?? {}, intervals: workout.intervals});
}

function durationMinOf(workout) {
    const seconds = workout?.meta?.duration;
    return Number.isFinite(seconds) ? Math.round(seconds / 60) : undefined;
}

function normalizeEntry(entry = {}) {
    const e = Object.assign({}, entry);
    e.id = e.id ?? uuid();
    e.date = isISODate(e.date) ? e.date : todayISO();
    e.workoutId = e.workoutId ?? null;
    e.workoutName = e.workoutName ?? e.workout?.meta?.name ?? '';
    e.notes = e.notes ?? '';
    e.status = STATUSES.includes(e.status) ? e.status : 'planned';
    if(e.durationMin === undefined) {
        const d = durationMinOf(e.workout);
        if(d !== undefined) e.durationMin = d;
    }
    return e;
}

function normalizePlan(plan = {}) {
    const p = Object.assign({}, plan);
    p.id = p.id ?? uuid();
    p.name = p.name ?? 'New plan';
    p.description = p.description ?? '';
    p.goal = p.goal ?? '';
    p.startDate = isISODate(p.startDate) ? p.startDate : weekStart(todayISO());
    p.entries = (p.entries ?? []).map(normalizeEntry);
    p.modified = Date.now();
    p.created = p.created ?? p.modified;
    return p;
}

// stable sort by date, keeping array order within a date
function sortEntries(entries) {
    return entries
        .map((e, i) => [e, i])
        .sort((a, b) => a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1])
        .map(([e]) => e);
}

function changed(action, planId, entryId) {
    const detail = {action, planId};
    if(entryId !== undefined) detail.entryId = entryId;
    xf.dispatch('plans:changed', detail);
}

//
// CRUD (contract API)
//
async function listPlans() {
    const plans = (await idb.getAll(STORE)) ?? [];
    cache.clear();
    plans.forEach(p => cache.set(p.id, p));
    return plans.sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
}

async function getPlan(id) {
    if(id === undefined || id === null) return undefined;
    const plan = await idb.get(STORE, id);
    if(plan && plan.id) {
        cache.set(plan.id, plan);
        return plan;
    }
    return undefined;
}

async function savePlan(plan) {
    const p = normalizePlan(plan);
    p.entries = sortEntries(p.entries);
    await idb.put(STORE, p);
    cache.set(p.id, p);
    changed('save', p.id);
    return p;
}

async function deletePlan(id) {
    await idb.remove(STORE, id);
    cache.delete(id);
    changed('delete', id);
    return id;
}

// all entries on a date across plans, each tagged with planId and planName
async function entriesForDate(date = todayISO()) {
    const plans = await listPlans();
    return plans.flatMap(plan =>
        (plan.entries ?? [])
            .filter(e => e.date === date)
            .map(e => Object.assign({}, e, {planId: plan.id, planName: plan.name}))
    );
}

async function updateEntry(planId, entryId, patch = {}) {
    const plan = await getPlan(planId);
    if(!plan) throw new Error(`:plans :updateEntry 'no plan ${planId}'`);
    const index = plan.entries.findIndex(e => e.id === entryId);
    if(index < 0) throw new Error(`:plans :updateEntry 'no entry ${entryId}'`);

    const next = Object.assign({}, plan.entries[index], patch, {id: entryId});
    plan.entries[index] = normalizeEntry(next);
    plan.entries = sortEntries(plan.entries);
    plan.modified = Date.now();
    await idb.put(STORE, plan);
    cache.set(plan.id, plan);
    changed('entry', plan.id, entryId);
    return plan.entries.find(e => e.id === entryId);
}

//
// Extras
//
async function createPlan(args = {}) {
    return savePlan(Object.assign({entries: []}, args, {id: undefined}));
}

function entryFromWorkout(workout, date, extra = {}) {
    return normalizeEntry(Object.assign({
        date,
        workoutId: workout?.id ?? null,
        workoutName: workout?.meta?.name ?? '',
        durationMin: durationMinOf(workout),
        workout: workoutSnapshot(workout),
    }, extra));
}

async function addEntry(planId, entry) {
    const plan = await getPlan(planId);
    if(!plan) throw new Error(`:plans :addEntry 'no plan ${planId}'`);
    const e = normalizeEntry(entry);
    plan.entries.push(e);
    await savePlan(plan);
    return e;
}

async function addWorkout(planId, workout, date, extra = {}) {
    return addEntry(planId, entryFromWorkout(workout, date, extra));
}

async function removeEntry(planId, entryId) {
    const plan = await getPlan(planId);
    if(!plan) return undefined;
    plan.entries = plan.entries.filter(e => e.id !== entryId);
    return savePlan(plan);
}

// move an entry to another date (appended to the end of that day)
async function moveEntry(planId, entryId, date) {
    const plan = await getPlan(planId);
    if(!plan) throw new Error(`:plans :moveEntry 'no plan ${planId}'`);
    const index = plan.entries.findIndex(e => e.id === entryId);
    if(index < 0) throw new Error(`:plans :moveEntry 'no entry ${entryId}'`);
    const [entry] = plan.entries.splice(index, 1);
    entry.date = date;
    plan.entries.push(entry);
    return savePlan(plan);
}

// reorder within the same day: direction -1 (earlier) or +1 (later)
async function reorderEntry(planId, entryId, direction = -1) {
    const plan = await getPlan(planId);
    if(!plan) return undefined;
    const entries = sortEntries(plan.entries);
    const i = entries.findIndex(e => e.id === entryId);
    if(i < 0) return plan;
    const sameDay = entries
        .map((e, j) => [e, j])
        .filter(([e]) => e.date === entries[i].date)
        .map(([, j]) => j);
    const pos = sameDay.indexOf(i);
    const target = sameDay[pos + direction];
    if(target === undefined) return plan;
    [entries[i], entries[target]] = [entries[target], entries[i]];
    plan.entries = entries;
    return savePlan(plan);
}

// copy the 7 days starting at fromWeekStart to toWeekStart (default: the next week)
async function duplicateWeek(planId, fromWeekStart, toWeekStart) {
    const plan = await getPlan(planId);
    if(!plan) throw new Error(`:plans :duplicateWeek 'no plan ${planId}'`);
    const to = toWeekStart ?? addDays(fromWeekStart, 7);
    const shift = diffDays(fromWeekStart, to);
    const end = addDays(fromWeekStart, 7);

    const copies = plan.entries
        .filter(e => e.date >= fromWeekStart && e.date < end)
        .map(e => {
            const copy = Object.assign({}, clone(e), {
                id: uuid(),
                date: addDays(e.date, shift),
                status: 'planned',
            });
            delete copy.activityId;
            delete copy.calendarEventId;
            return copy;
        });

    plan.entries = plan.entries.concat(copies);
    return savePlan(plan);
}

async function setEntryStatus(planId, entryId, status, extra = {}) {
    return updateEntry(planId, entryId, Object.assign({status}, extra));
}

//
// Import / Export (JSON)
//
function exportPlan(plan) {
    return JSON.stringify({
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exported: new Date().toISOString(),
        plan,
    }, null, 2);
}

function parsePlanJSON(input) {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    const plan = data?.format === EXPORT_FORMAT ? data.plan : (data?.plan ?? data);
    if(!plan || !Array.isArray(plan.entries)) {
        throw new Error(`:plans :import 'not a training plan'`);
    }
    return plan;
}

// imports as a new plan (fresh ids) unless keepIds is true
async function importPlan(input, {keepIds = false} = {}) {
    const plan = clone(parsePlanJSON(input));
    if(!keepIds) {
        delete plan.id;
        delete plan.created;
        plan.entries = plan.entries.map(e => {
            const copy = Object.assign({}, e);
            delete copy.id;
            delete copy.calendarEventId;
            return copy;
        });
    }
    return savePlan(plan);
}

//
// Workout resolution and "today"
//
// find the library workout for an entry: by id, then by name, then the snapshot
function resolveWorkout(entry, workouts = []) {
    if(!entry) return undefined;
    const byId = workouts.find(w => entry.workoutId && w.id === entry.workoutId);
    if(byId) return byId;
    const byName = workouts.find(w => entry.workoutName && w?.meta?.name === entry.workoutName);
    if(byName) return byName;
    if(entry.workout && Array.isArray(entry.workout.intervals)) {
        return Object.assign(clone(entry.workout), {id: entry.workoutId ?? `plan:${entry.id}`});
    }
    return undefined;
}

function cachedEntriesForDate(date = todayISO()) {
    return Array.from(cache.values()).flatMap(plan =>
        (plan.entries ?? [])
            .filter(e => e.date === date)
            .map(e => Object.assign({}, e, {planId: plan.id, planName: plan.name}))
    );
}

// sync: does a local plan have a not-yet-done entry today? (uses the in-memory cache)
function hasPlannedToday(date = todayISO()) {
    return cachedEntriesForDate(date).some(e => e.status === 'planned');
}

async function todayEntries() {
    return entriesForDate(todayISO());
}

export {
    // contract
    listPlans,
    getPlan,
    savePlan,
    deletePlan,
    entriesForDate,
    updateEntry,

    // extras
    createPlan,
    addEntry,
    addWorkout,
    removeEntry,
    moveEntry,
    reorderEntry,
    duplicateWeek,
    setEntryStatus,
    exportPlan,
    importPlan,
    parsePlanJSON,
    resolveWorkout,
    entryFromWorkout,
    workoutSnapshot,
    hasPlannedToday,
    cachedEntriesForDate,
    todayEntries,

    // date helpers
    todayISO,
    toISODate,
    addDays,
    diffDays,
    weekStart,

    STORE,
    STATUSES,
};
