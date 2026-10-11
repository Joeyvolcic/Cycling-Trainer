//
// Today's plan entry <-> current workout
//
// - On startup (after the session is restored) a local plan entry planned for today
//   is loaded as the current workout. A local plan wins over intervals.icu planned
//   workouts (models.planned.wod() checks hasPlannedToday()); the Plans view offers
//   the intervals.icu workout as an alternative.
// - When an activity is saved for the workout of today's entry, the entry is
//   marked `done` with `activityId`.
//
// Events:
//   in:  ui:plans:ride {planId, entryId}   load an entry's workout and go home
//   out: plans:today   {entry, workout}    an entry's workout was loaded
//        plans:active  {planId, entryId, workoutId} | null
//

import { xf } from '../../functions.js';
import {
    listPlans, entriesForDate, updateEntry, resolveWorkout, todayISO,
} from './plans.js';

const ACTIVE_KEY = 'plans:active';

let active = readActive();
let started = false;

function readActive() {
    try {
        return JSON.parse(window.localStorage.getItem(ACTIVE_KEY) ?? 'null');
    } catch(_) {
        return null;
    }
}

function setActive(value) {
    active = value;
    try {
        if(value) {
            window.localStorage.setItem(ACTIVE_KEY, JSON.stringify(value));
        } else {
            window.localStorage.removeItem(ACTIVE_KEY);
        }
    } catch(_) {}
    xf.dispatch('plans:active', value);
}

function getActive() {
    return active;
}

function loadEntry(entry, db) {
    const workout = resolveWorkout(entry, db.workouts ?? []);
    if(!workout) {
        console.warn(`:plans :today 'workout not found for entry'`, entry);
        return undefined;
    }
    setActive({planId: entry.planId, entryId: entry.id, workoutId: workout.id, date: entry.date});
    xf.dispatch('workout', workout);
    xf.dispatch('plans:today', {entry, workout});
    return workout;
}

function isRiding(db) {
    return (db.elapsed ?? 0) > 0;
}

// startup: after models.session.restore() in db.js 'app:start'
xf.reg('workout:restore', async function(_, db) {
    try {
        await listPlans(); // fill the cache used by hasPlannedToday()
        if(isRiding(db)) return; // resumed session keeps its workout (and active entry)

        const entries = (await entriesForDate(todayISO())).filter(e => e.status === 'planned');
        if(entries.length > 0) {
            loadEntry(entries[0], db);
        } else if(active) {
            setActive(null);
        }
    } catch(err) {
        console.error(`:plans :today :restore`, err);
    } finally {
        started = true;
    }
});

xf.reg('ui:plans:ride', async function({planId, entryId} = {}, db) {
    const entries = await listPlans();
    const plan = entries.find(p => p.id === planId);
    const entry = plan?.entries.find(e => e.id === entryId);
    if(!entry) return;
    if(isRiding(db)) {
        console.warn(`:plans :ride 'a ride is in progress, not switching workout'`);
        return;
    }
    if(loadEntry(Object.assign({}, entry, {planId: plan.id, planName: plan.name}), db)) {
        xf.dispatch('action:nav', 'home');
    }
});

// the user picked another workout -> the plan entry is no longer active
xf.sub('db:workout', workout => {
    if(!started || !active) return;
    if(workout?.id !== active.workoutId) setActive(null);
});

// activity saved (db.js 'watch:stopped' -> models.activity.createFromCurrent)
xf.reg('activity:add', async function(summary, db) {
    const workout = db.workout; // capture synchronously, the session resets afterwards
    const current = active;
    try {
        let target;
        if(current && workout?.id === current.workoutId) {
            target = {planId: current.planId, entryId: current.entryId};
        } else {
            const entries = await entriesForDate(todayISO());
            const match = entries.find(e => e.status === 'planned' && (
                (e.workoutId && e.workoutId === workout?.id) ||
                (e.workoutName && e.workoutName === workout?.meta?.name)));
            if(match) target = {planId: match.planId, entryId: match.id};
        }
        if(!target) return;

        await updateEntry(target.planId, target.entryId, {status: 'done', activityId: summary?.id});
        setActive(null);
    } catch(err) {
        console.error(`:plans :today :activity`, err);
    }
});

export { getActive, loadEntry };
