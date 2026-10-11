// STUB — real implementation comes from the plans branch
//
// Implements exactly the contract signatures from doc/integrations-contract.md
// with an in-memory store so the AI readiness feature can be developed and
// tested independently. Do not build on this file; it will be replaced.
import { xf } from '../../functions.js';

let plans = [];

async function listPlans() {
    return plans.slice();
}

async function getPlan(id) {
    return plans.find((p) => p.id === id);
}

async function savePlan(plan) {
    plans = plans.filter((p) => p.id !== plan.id).concat([plan]);
    xf.dispatch('plans:changed', plan.id);
    return plan;
}

async function deletePlan(id) {
    plans = plans.filter((p) => p.id !== id);
    xf.dispatch('plans:changed', id);
}

// 'YYYY-MM-DD' -> [{planId, ...entry}]
async function entriesForDate(date) {
    return plans.flatMap((plan) =>
        (plan.entries ?? [])
            .filter((e) => e.date === date)
            .map((e) => Object.assign({planId: plan.id}, e))
    );
}

async function updateEntry(planId, entryId, patch) {
    const plan = plans.find((p) => p.id === planId);
    if(!plan) return undefined;
    const entry = (plan.entries ?? []).find((e) => e.id === entryId);
    if(!entry) return undefined;
    Object.assign(entry, patch);
    xf.dispatch('plans:changed', planId);
    return entry;
}

export {
    listPlans,
    getPlan,
    savePlan,
    deletePlan,
    entriesForDate,
    updateEntry,
};
