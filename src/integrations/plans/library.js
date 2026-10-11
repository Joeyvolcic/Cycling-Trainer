//
// Workout library persistence helpers
//
// Fills gaps around storing custom workouts: save from the editor (create/update),
// rename, edit, export (.zwo / JSON) and JSON import. Library workouts live in the
// IndexedDB store `workouts` (models.workouts), built-in workouts are in-memory only.
//
// Events (xf):
//   ui:workout:save        workout        -> upsert into db.workouts + IDB
//   ui:workout:rename      {id, name}
//   ui:workout:edit        id             -> loads it into the editor (copy for built-ins)
//   ui:workout:new                         -> empty editor
//   ui:workout:export      id             -> download .zwo (or .json for courses)
//   ui:workouts:export-json               -> download all custom workouts as JSON
//   ui:workouts:import-json text          -> add workouts from a JSON export
// Dispatches:
//   ui:editor:load         workout | null
//   library:saved          workout
//

import { xf } from '../../functions.js';
import { models } from '../../models/models.js';
import { zwo } from '../../workouts/zwo.js';
import { fileHandler } from '../../file.js';
import { uuid } from '../../storage/uuid.js';

const EXPORT_FORMAT = 'auuki-workouts';

function plain(workout) {
    // drop view-only props added by the list (graph, selected)
    const { graph, selected, ...rest } = workout;
    return JSON.parse(JSON.stringify(rest));
}

function isBuiltin(id) {
    return (models.workouts.default ?? []).some(w => w.id === id);
}

function safeFileName(name = 'workout') {
    return String(name).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'workout';
}

function download(text, name, type = 'text/plain') {
    fileHandler.download()(text, name, type);
}

function toZwo(workout) {
    return zwo.write(zwo.fromInterval(workout));
}

function parseWorkoutsJSON(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    const list = Array.isArray(data) ? data : (data?.workouts ?? [data]);
    return list.filter(w => w && w.meta && (Array.isArray(w.intervals) || Array.isArray(w.points)));
}

function upsert(db, workout) {
    const w = plain(workout);
    w.id = w.id ?? uuid();
    const workouts = db.workouts ?? [];
    const index = workouts.findIndex(x => x.id === w.id);
    if(index >= 0) {
        workouts[index] = w;
        models.workouts.save(w);
    } else {
        models.workouts.add(workouts, w);
    }
    db.workouts = workouts; // proxy set -> db:workouts
    if(db.workout?.id === w.id) db.workout = w;
    xf.dispatch('library:saved', w);
    return w;
}

xf.reg('ui:workout:save', (workout, db) => {
    if(!workout || !workout.meta) return;
    upsert(db, workout);
});

xf.reg('ui:workout:rename', ({id, name} = {}, db) => {
    const workout = (db.workouts ?? []).find(w => w.id === id);
    if(!workout || !name) return;
    if(isBuiltin(id)) {
        // built-ins are not persisted: store a renamed copy
        upsert(db, Object.assign(plain(workout), {id: uuid(), meta: Object.assign({}, workout.meta, {name})}));
        return;
    }
    workout.meta = Object.assign({}, workout.meta, {name});
    upsert(db, workout);
});

xf.reg('ui:workout:edit', (id, db) => {
    const workout = (db.workouts ?? []).find(w => w.id === id);
    if(!workout || !Array.isArray(workout.intervals)) return;
    let copy = plain(workout);
    if(isBuiltin(id)) {
        delete copy.id;
        copy.meta.name = `${copy.meta.name} (custom)`;
    }
    xf.dispatch('ui:editor:load', copy);
    xf.dispatch('action:nav', 'workouts:editor');
});

xf.reg('ui:workout:new', () => {
    xf.dispatch('ui:editor:load', null);
    xf.dispatch('action:nav', 'workouts:editor');
});

xf.reg('ui:workout:export', (id, db) => {
    const workout = (db.workouts ?? []).find(w => w.id === id);
    if(!workout) return;
    const name = safeFileName(workout.meta?.name);
    if(Array.isArray(workout.intervals)) {
        download(toZwo(workout), `${name}.zwo`, 'text/plain');
    } else {
        download(JSON.stringify({format: EXPORT_FORMAT, version: 1, workouts: [plain(workout)]}, null, 2),
                 `${name}.json`, 'application/json');
    }
});

xf.reg('ui:workouts:export-json', (_, db) => {
    const custom = (db.workouts ?? []).filter(w => !isBuiltin(w.id)).map(plain);
    download(JSON.stringify({format: EXPORT_FORMAT, version: 1, workouts: custom}, null, 2),
             `auuki-workouts.json`, 'application/json');
});

xf.reg('ui:workouts:import-json', (text, db) => {
    let list = [];
    try {
        list = parseWorkoutsJSON(text);
    } catch(err) {
        console.error(`:library :import-json :error`, err);
        return;
    }
    const workouts = db.workouts ?? [];
    list.forEach(w => {
        const copy = plain(w);
        copy.id = uuid();
        models.workouts.add(workouts, copy);
    });
    db.workouts = workouts;
});

export { parseWorkoutsJSON, isBuiltin, toZwo, plain };
