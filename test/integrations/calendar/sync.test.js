import { syncPlan, unsyncPlan } from '../../../src/integrations/calendar/sync.js';
import { eventIdFor } from '../../../src/integrations/calendar/event.js';
import { formatDate, formatTime } from '../../../src/integrations/calendar/scheduler.js';

const now = new Date(2026, 9, 11, 20, 0); // Sunday 2026-10-11 20:00 local
const baseUrl = 'https://flux.example.com/';
const prefs = {
    windows: {weekday: [{start: '06:00', end: '07:30'}], weekend: [{start: '07:00', end: '11:00'}]},
    bufferMin: 0, maxShiftDays: 1, minRestDaysBetweenHard: 1,
};

function local(dateStr, hh, mm = 0) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, hh, mm);
}

class FakeError extends Error {
    constructor(status) { super(`fake ${status}`); this.status = status; }
}

// Minimal in-memory Google Calendar
function FakeClient({busy = []} = {}) {
    const events = new Map(); // id -> event
    const calls = [];
    let seq = 0;

    const clone = (x) => JSON.parse(JSON.stringify(x));
    const startOf = (ev) => new Date(ev.start.dateTime ?? ev.start.date);

    return {
        events, calls,
        async freeBusy({timeMin, timeMax}) {
            calls.push(['freeBusy']);
            const own = [...events.values()].filter(e => e.status !== 'cancelled')
                .map(e => ({start: e.start.dateTime, end: e.end.dateTime}));
            return [...busy, ...own].filter(b =>
                new Date(b.end) > new Date(timeMin) && new Date(b.start) < new Date(timeMax));
        },
        async listEvents(calendarId, {timeMin, timeMax, privateExtendedProperty} = {}) {
            calls.push(['list']);
            const [k, v] = (privateExtendedProperty ?? '').split('=');
            return [...events.values()].filter(e =>
                e.status !== 'cancelled' &&
                (!k || e.extendedProperties?.private?.[k] === v) &&
                (!timeMin || startOf(e) >= new Date(timeMin)) &&
                (!timeMax || startOf(e) < new Date(timeMax))).map(clone);
        },
        async getEvent(calendarId, id) {
            calls.push(['get', id]);
            return events.has(id) ? clone(events.get(id)) : null;
        },
        async insertEvent(calendarId, body) {
            calls.push(['insert', body.id]);
            const id = body.id ?? `gen${seq++}`;
            if(events.has(id)) throw new FakeError(409);
            const ev = {...clone(body), id, status: 'confirmed'};
            events.set(id, ev);
            return clone(ev);
        },
        async patchEvent(calendarId, id, body) {
            calls.push(['patch', id]);
            if(!events.has(id)) throw new FakeError(404);
            const ev = Object.assign(events.get(id), clone(body));
            return clone(ev);
        },
        async deleteEvent(calendarId, id) {
            calls.push(['delete', id]);
            if(events.has(id)) events.get(id).status = 'cancelled';
        },
    };
}

function makePlan() {
    return {
        id: 'plan1', name: 'Base build', startDate: '2026-10-12', goal: 'FTP',
        entries: [
            {id: 'e1', date: '2026-10-12', workoutId: 'w1', workoutName: 'VO2max 5x4', durationMin: 60, status: 'planned', notes: 'Go hard'},
            {id: 'e2', date: '2026-10-13', workoutId: 'w2', workoutName: 'Recovery spin', durationMin: 45, status: 'planned'},
            {id: 'e3', date: '2026-10-17', workoutId: 'w3', workoutName: 'Endurance', durationMin: 120, status: 'planned'},
            {id: 'e0', date: '2026-10-05', workoutId: 'w0', workoutName: 'Old', durationMin: 60, status: 'done'},
        ],
    };
}

function updater(plan) {
    const calls = [];
    const fn = async (planId, entryId, patch) => {
        calls.push([planId, entryId, patch]);
        Object.assign(plan.entries.find(e => e.id === entryId), patch);
    };
    fn.calls = calls;
    return fn;
}

const opts = (client, updateEntry, extra = {}) =>
    ({client, prefs, now, baseUrl, updateEntry, timeZone: 'UTC', ...extra});

describe('syncPlan', () => {
    test('creates events with title, description, deep link, reminder and stores calendarEventId', async () => {
        const plan = makePlan();
        const client = FakeClient();
        const up = updater(plan);
        const report = await syncPlan(plan, opts(client, up, {describe: () => '5x4min @ 120% FTP'}));

        expect(report.created.sort()).toEqual(['e1', 'e2', 'e3']);
        expect(client.events.size).toBe(3);

        const ev = client.events.get(eventIdFor('plan1', 'e1'));
        expect(ev.summary).toBe('VO2max 5x4');
        expect(ev.description).toContain('5x4min @ 120% FTP');
        expect(ev.description).toContain('Go hard');
        expect(ev.description).toContain('Plan: Base build');
        expect(ev.description).toContain('https://flux.example.com/?planEntry=e1&plan=plan1&workout=w1');
        expect(ev.source.url).toContain('planEntry=e1');
        expect(ev.reminders).toEqual({useDefault: false, overrides: [{method: 'popup', minutes: 15}]});
        expect(ev.extendedProperties.private).toMatchObject({fluxPlanId: 'plan1', fluxEntryId: 'e1', fluxEntryDate: '2026-10-12'});
        expect(formatTime(new Date(ev.start.dateTime))).toBe('06:00');
        expect(formatDate(new Date(ev.start.dateTime))).toBe('2026-10-12');

        expect(plan.entries[0].calendarEventId).toBe(eventIdFor('plan1', 'e1'));
        expect(up.calls.length).toBe(3);
        // done entries are not touched
        expect(plan.entries[3].calendarEventId).toBeUndefined();
    });

    test('event ids are valid google base32hex ids', () => {
        expect(eventIdFor('plan-1', 'entry_ü')).toMatch(/^[a-v0-9]{5,1024}$/);
    });

    test('re-sync is idempotent: no writes, no updateEntry calls', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        client.calls.length = 0;
        const up = updater(plan);
        const report = await syncPlan(plan, opts(client, up));

        expect(report.unchanged.sort()).toEqual(['e1', 'e2', 'e3']);
        expect(report.created).toEqual([]);
        expect(client.calls.filter(c => ['insert', 'patch', 'delete'].includes(c[0]))).toEqual([]);
        expect(up.calls).toEqual([]);
        expect(client.events.size).toBe(3);
    });

    test('recovers when calendarEventId was lost (409 -> patch, no duplicate)', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        // simulate an event deleted in google (cancelled) and the id dropped locally
        await client.deleteEvent('primary', eventIdFor('plan1', 'e2'));
        plan.entries[1].calendarEventId = undefined;

        const report = await syncPlan(plan, opts(client, updater(plan)));
        expect(report.updated).toContain('e2');
        expect(client.events.get(eventIdFor('plan1', 'e2')).status).toBe('confirmed');
        expect(client.events.size).toBe(3);
        expect(plan.entries[1].calendarEventId).toBe(eventIdFor('plan1', 'e2'));
    });

    test('text changes are patched in place', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        plan.entries[2].workoutName = 'Endurance + sprints';
        const report = await syncPlan(plan, opts(client, updater(plan)));
        expect(report.updated).toEqual(['e3']);
        expect(client.events.get(eventIdFor('plan1', 'e3')).summary).toBe('Endurance + sprints');
    });

    test('plan date change moves the event', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        plan.entries[2].date = '2026-10-18'; // Saturday -> Sunday
        const report = await syncPlan(plan, opts(client, updater(plan)));
        expect(report.moved).toEqual(['e3']);
        const ev = client.events.get(eventIdFor('plan1', 'e3'));
        expect(formatDate(new Date(ev.start.dateTime))).toBe('2026-10-18');
        expect(ev.extendedProperties.private.fluxEntryDate).toBe('2026-10-18');
        expect(client.events.size).toBe(3);
    });

    test('rider dragging the event to another day is adopted into the plan', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        const ev = client.events.get(eventIdFor('plan1', 'e3'));
        ev.start.dateTime = local('2026-10-18', 9).toISOString();
        ev.end.dateTime = local('2026-10-18', 11).toISOString();

        const up = updater(plan);
        const report = await syncPlan(plan, opts(client, up));
        expect(report.adopted).toEqual(['e3']);
        expect(plan.entries[2].date).toBe('2026-10-18');
        expect(up.calls).toContainEqual(['plan1', 'e3', {date: '2026-10-18'}]);
        // time chosen by rider is kept
        expect(formatTime(new Date(client.events.get(eventIdFor('plan1', 'e3')).start.dateTime))).toBe('09:00');

        // and it is stable afterwards
        const again = await syncPlan(plan, opts(client, updater(plan)));
        expect(again.unchanged).toContain('e3');
        expect(again.adopted).toEqual([]);
    });

    test('skipped and removed entries delete their events', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        plan.entries[0].status = 'skipped';
        plan.entries = plan.entries.filter(e => e.id !== 'e2');
        const report = await syncPlan(plan, opts(client, updater(plan)));
        expect(report.deleted.sort()).toEqual(['e1', 'e2']);
        expect(client.events.get(eventIdFor('plan1', 'e1')).status).toBe('cancelled');
        expect(client.events.get(eventIdFor('plan1', 'e2')).status).toBe('cancelled');
        expect(plan.entries[0].calendarEventId).toBe(null);
    });

    test('done entries keep their events', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        plan.entries[0].status = 'done';
        const report = await syncPlan(plan, opts(client, updater(plan)));
        expect(report.deleted).toEqual([]);
    });

    test('busy time from other calendars is avoided and shift updates the entry date', async () => {
        const plan = makePlan();
        const client = FakeClient({busy: [
            {start: local('2026-10-12', 0).toISOString(), end: local('2026-10-12', 23).toISOString()},
        ]});
        const up = updater(plan);
        const report = await syncPlan(plan, opts(client, up));
        // Monday is fully busy: e1 moves to Tuesday, which pushes e2 (max 1/day) to Wednesday
        expect(report.unscheduled).toEqual([]);
        expect(plan.entries[0].date).toBe('2026-10-13');
        expect(plan.entries[1].date).toBe('2026-10-14');
        expect(up.calls).toContainEqual(['plan1', 'e1', {calendarEventId: eventIdFor('plan1', 'e1'), date: '2026-10-13'}]);
        const ev = client.events.get(eventIdFor('plan1', 'e1'));
        expect(ev.extendedProperties.private.fluxEntryDate).toBe('2026-10-13');

        // stable on re-sync
        const again = await syncPlan(plan, opts(client, updater(plan)));
        expect(again.unchanged.sort()).toEqual(['e1', 'e2', 'e3']);
    });

    test('entries beyond the horizon are not synced', async () => {
        const plan = makePlan();
        plan.entries.push({id: 'far', date: '2026-12-24', workoutName: 'Xmas', durationMin: 60, status: 'planned'});
        const client = FakeClient();
        const report = await syncPlan(plan, opts(client, updater(plan), {horizonDays: 14}));
        expect(report.created).not.toContain('far');
    });

    test('unsyncPlan removes all events', async () => {
        const plan = makePlan();
        const client = FakeClient();
        await syncPlan(plan, opts(client, updater(plan)));
        const up = updater(plan);
        const n = await unsyncPlan(plan, {client, updateEntry: up});
        expect(n).toBe(3);
        expect([...client.events.values()].every(e => e.status === 'cancelled')).toBe(true);
        expect(plan.entries.filter(e => e.calendarEventId).length).toBe(0);
    });
});
