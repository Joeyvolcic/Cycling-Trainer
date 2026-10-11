// STUB — real implementation comes from the plans branch
//
// Implements exactly the contract signatures from doc/integrations-contract.md
// so the calendar integration can be built and tested in isolation. Backed by
// localStorage (key `plans:stub`) instead of the IndexedDB `plans` store.

import { xf } from '../../functions.js';

const KEY = 'plans:stub';

function read() {
    try {
        const raw = globalThis.localStorage?.getItem(KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (_) {
        return [];
    }
}

function write(plans) {
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(plans)); } catch (_) {}
    xf.dispatch('plans:changed', plans);
}

async function listPlans() {
    return read();
}

async function getPlan(id) {
    return read().find(p => p.id === id);
}

async function savePlan(plan) {
    const plans = read().filter(p => p.id !== plan.id);
    plans.push(plan);
    write(plans);
    return plan;
}

async function deletePlan(id) {
    write(read().filter(p => p.id !== id));
}

async function entriesForDate(date) {
    return read().flatMap(p =>
        (p.entries ?? []).filter(e => e.date === date).map(e => ({...e, planId: p.id}))
    );
}

async function updateEntry(planId, entryId, patch) {
    const plans = read();
    const plan = plans.find(p => p.id === planId);
    if(!plan) return undefined;
    const entry = (plan.entries ?? []).find(e => e.id === entryId);
    if(!entry) return undefined;
    Object.assign(entry, patch);
    write(plans);
    return entry;
}

export { listPlans, getPlan, savePlan, deletePlan, entriesForDate, updateEntry };
