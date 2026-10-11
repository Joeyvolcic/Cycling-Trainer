// watch.js dispatches 'watch:intervalDuration' when an interval starts; a
// handler must write it to db.intervalDuration (it used to be registered as
// 'watch:lapDuration', which nothing dispatches, so db.intervalDuration stayed 0).
//
// watch.js can't be imported under jest (it spawns a Worker via import.meta.url),
// so this checks the wiring statically: every 'watch:*' event registered in
// watch.js must be dispatched somewhere in src/, and vice versa for the
// store-writing duration events.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../src');

function walk(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(d =>
        d.isDirectory() ? walk(path.join(dir, d.name)) :
        d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
}

const watchSrc = fs.readFileSync(path.join(SRC, 'watch.js'), 'utf8');
const allSrc = walk(SRC).map(f => fs.readFileSync(f, 'utf8')).join('\n');

const names = (re, src) => new Set(Array.from(src.matchAll(re), m => m[1]));
const registered = names(/xf\.reg\(\s*['"`](watch:[\w-]+)['"`]/g, watchSrc);
const dispatched = names(/xf\.dispatch\(\s*['"`](watch:[\w-]+)['"`]/g, allSrc);

describe('watch -> db wiring', () => {
    test('watch:intervalDuration writes db.intervalDuration', () => {
        expect(watchSrc).toMatch(
            /xf\.reg\(\s*'watch:intervalDuration',\s*\(time, db\) => db\.intervalDuration = time\)/);
        expect(dispatched.has('watch:intervalDuration')).toBe(true);
    });

    test('no dead watch:* registrations', () => {
        const dead = Array.from(registered).filter(n => !dispatched.has(n));
        expect(dead).toEqual([]);
    });

    test('duration/time events dispatched by the watch are all registered', () => {
        const store = Array.from(dispatched).filter(n => /Duration$|Time$|Index$/.test(n));
        const missing = store.filter(n => !registered.has(n));
        expect(missing).toEqual([]);
    });
});
