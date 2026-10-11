/**
 * @jest-environment jsdom
 */

// End-to-end over the xf bus: today's local plan entry is loaded on startup
// (plans/today.js), the quick-start card offers / starts it, and the saved
// activity marks the entry done.

import indexedDB from 'fake-indexeddb';
import { xf } from '../../src/functions.js';
import { idb } from '../../src/storage/idb.js';
import { savePlan, getPlan, listPlans, todayISO } from '../../src/integrations/plans/plans.js';
import { getActive } from '../../src/integrations/plans/today.js';
import { todayOffer } from '../../src/integrations/ui/quick-start.js';

window.indexedDB = indexedDB;

global.console = {
    log: jest.fn(),
    error: console.error,
    warn: jest.fn(),
};

const flush = () => new Promise(res => setTimeout(res, 0));
async function waitFor(fn, tries = 100) {
    for(let i = 0; i < tries; i++) {
        if(fn()) return;
        await flush();
    }
    throw new Error('waitFor timed out');
}

const sweetSpot = {
    id: 'w-ss',
    meta: {name: 'Sweet Spot 3x10', duration: 600},
    intervals: [{duration: 600, steps: [{duration: 600, power: 0.9}]}],
};
const endurance = {
    id: 'w-end',
    meta: {name: 'Endurance', duration: 600},
    intervals: [{duration: 600, steps: [{duration: 600, power: 0.6}]}],
};

// minimal stand-in for the db.js store handlers used here
const db = {workouts: [sweetSpot, endurance], workout: null, elapsed: 0};
xf.create(db);
xf.reg('workout', (workout, db) => { db.workout = workout; });
xf.reg('ui:workout:select', (id, db) => { db.workout = db.workouts.find(w => w.id === id); });

const seen = {};
['ui:watchStart', 'ui:workoutStart', 'plans:today', 'action:nav'].forEach(name => {
    seen[name] = [];
    xf.sub(name, x => seen[name].push(x));
});

// the card is in index.html from the start, so it sees every db:workout change
document.body.innerHTML = '<quick-start></quick-start>';
const card = document.querySelector('quick-start');

async function seedPlan(entry = {}) {
    await idb.clear('plans');
    await listPlans();
    return savePlan({id: 'plan-1', name: 'Base', entries: [Object.assign({
        id: 'e-today', date: todayISO(), workoutId: sweetSpot.id, workoutName: sweetSpot.meta.name,
        status: 'planned',
    }, entry)]});
}

async function entryStatus() {
    return (await getPlan('plan-1')).entries[0];
}

describe("today's plan entry, quick start and ride", () => {
    beforeAll(async () => {
        await idb.start('plans-today-test', 1, ['plans']);
    });

    beforeEach(() => {
        Object.values(seen).forEach(list => list.length = 0);
    });

    test('startup loads the entry, Start rides it, the saved ride marks it done', async () => {
        await seedPlan();
        db.workout = endurance; // whatever the session restored

        xf.dispatch('workout:restore');
        await waitFor(() => seen['plans:today'].length > 0);

        expect(db.workout.id).toBe(sweetSpot.id);
        expect(getActive()).toMatchObject({planId: 'plan-1', entryId: 'e-today', workoutId: sweetSpot.id});

        expect(card.querySelector('.qs--start--label').textContent).toBe("Start today's plan: Sweet Spot 3x10");
        expect(card.querySelector('.qs--today').hidden).toBe(true);

        card.querySelector('.qs--start').click();
        expect(seen['ui:watchStart'].length).toBe(1);
        expect(seen['ui:workoutStart'].length).toBe(1);

        // db.js 'watch:stopped' -> models.activity.createFromCurrent -> 'activity:add'
        xf.dispatch('activity:add', {id: 'act-1'});
        await waitFor(() => getActive() === null);
        expect(await entryStatus()).toMatchObject({status: 'done', activityId: 'act-1'});
    });

    test('picking another workout offers the entry; tapping it loads it again', async () => {
        await seedPlan();
        xf.dispatch('ui:plans:ride', {planId: 'plan-1', entryId: 'e-today'});
        await waitFor(() => getActive() !== null);

        xf.dispatch('ui:workout:select', endurance.id);
        expect(getActive()).toBe(null);

        const $today = card.querySelector('.qs--today');
        expect(card.querySelector('.qs--start--label').textContent).toBe('Start Endurance');
        expect($today.hidden).toBe(false);
        expect($today.dataset).toMatchObject({kind: 'plan', planId: 'plan-1', entryId: 'e-today'});
        expect($today.textContent).toContain('Sweet Spot 3x10');

        $today.click();
        await waitFor(() => getActive() !== null);
        expect(db.workout.id).toBe(sweetSpot.id);
        expect($today.hidden).toBe(true);
        expect(card.querySelector('.qs--start--label').textContent).toBe("Start today's plan: Sweet Spot 3x10");
    });

    test('an AI-adjusted copy of the workout still rides the entry', async () => {
        await seedPlan();
        xf.dispatch('ui:plans:ride', {planId: 'plan-1', entryId: 'e-today'});
        await waitFor(() => getActive() !== null);

        const adjusted = Object.assign({}, sweetSpot, {
            id: 'w-adjusted',
            meta: Object.assign({}, sweetSpot.meta, {name: 'Sweet Spot 3x10 (AI: 90%)', adjustedFrom: sweetSpot.id}),
        });
        xf.dispatch('workout', adjusted);
        expect(getActive()).toMatchObject({entryId: 'e-today', workoutId: 'w-adjusted'});

        xf.dispatch('activity:add', {id: 'act-2'});
        await waitFor(() => getActive() === null);
        expect(await entryStatus()).toMatchObject({status: 'done', activityId: 'act-2'});
    });

    test('todayOffer: local plan wins over intervals.icu, which is the fallback', () => {
        const entry = {id: 'e', planId: 'p', workoutName: 'Local'};
        const icu = {id: 'icu-1', meta: {name: 'ICU', startDateLocal: new Date().toISOString()}};
        expect(todayOffer({entry, planned: [icu], workout: endurance}))
            .toEqual({kind: 'plan', entry, loaded: false});
        expect(todayOffer({entry, active: {planId: 'p', entryId: 'e', workoutId: 'w-end'}, workout: endurance}))
            .toEqual({kind: 'plan', entry, loaded: true});
        expect(todayOffer({planned: [icu], workout: endurance}))
            .toEqual({kind: 'intervals', workout: icu, loaded: false});
        expect(todayOffer({planned: [], workout: endurance})).toBe(null);
    });

    // keep last: a deep link sticks for the session
    test('a deep link at startup is not overridden by the plan entry', async () => {
        await seedPlan();
        db.workout = endurance;
        xf.dispatch('app:deeplink', {workout: endurance.id});
        xf.dispatch('workout:restore');
        for(let i = 0; i < 20; i++) await flush();
        expect(db.workout.id).toBe(endurance.id);
        expect(seen['plans:today'].length).toBe(0);
    });
});
