//
// Idempotent plan -> Google Calendar sync.
//
// The Google client is injected (see google.js GoogleCalendarClient) so this
// module is testable with a fake. Every event we create carries private
// extended properties {fluxPlanId, fluxEntryId, fluxEntryDate} which lets a
// re-sync find its own events even if `calendarEventId` was never saved, and
// tell "the plan moved this ride" from "the rider dragged the event".
//

import { scheduleEntries, isHardEntry, formatDate, addDays, parseDate } from './scheduler.js';
import { eventTitle, eventDescription, eventIdFor, deepLink, APP_TAG } from './event.js';

function localTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return undefined; }
}

function eventStart(ev) {
    if(ev?.start?.dateTime) return new Date(ev.start.dateTime);
    if(ev?.start?.date) return parseDate(ev.start.date);
    return null;
}
function eventEnd(ev) {
    if(ev?.end?.dateTime) return new Date(ev.end.dateTime);
    if(ev?.end?.date) return parseDate(ev.end.date);
    return null;
}

function isActive(entry, todayStr, endStr) {
    const status = entry.status ?? 'planned';
    return status === 'planned' && entry.date >= todayStr && entry.date <= endStr;
}

function buildEventBody({plan, entry, start, end, reminderMin, describe, baseUrl, timeZone}) {
    const link = deepLink(entry, plan.id, baseUrl);
    const body = {
        summary: eventTitle(entry),
        description: eventDescription(entry, {
            planName: plan.name, summary: describe?.(entry), link,
        }),
        reminders: {
            useDefault: false,
            overrides: reminderMin > 0 ? [{method: 'popup', minutes: reminderMin}] : [],
        },
        extendedProperties: {private: {
            app: APP_TAG,
            fluxPlanId: String(plan.id),
            fluxEntryId: String(entry.id),
            fluxEntryDate: entry.date,
        }},
    };
    if(/^https?:/.test(link)) body.source = {title: 'Flux training plan', url: link};
    if(start && end) {
        body.start = {dateTime: start.toISOString(), timeZone};
        body.end   = {dateTime: end.toISOString(), timeZone};
    }
    return body;
}

function needsTextPatch(ev, body) {
    const rem = ev.reminders?.overrides ?? [];
    const want = body.reminders.overrides;
    return ev.summary !== body.summary ||
        (ev.description ?? '') !== body.description ||
        ev.reminders?.useDefault !== false ||
        rem.length !== want.length ||
        rem.some((r, i) => r.minutes !== want[i]?.minutes || r.method !== want[i]?.method) ||
        ev.extendedProperties?.private?.fluxEntryDate !== body.extendedProperties.private.fluxEntryDate;
}

/**
 * @param {Object} plan     contract TrainingPlan
 * @param {Object} options
 *   client          GoogleCalendarClient-like object (required)
 *   prefs           scheduler prefs
 *   updateEntry     (planId, entryId, patch) => Promise (plans.js updateEntry)
 *   calendarId      target calendar (default 'primary')
 *   busyCalendarIds calendars to consult for free/busy (default [calendarId])
 *   horizonDays     only sync entries up to N days ahead (default 28)
 *   reminderMin     popup reminder (default 15)
 *   describe        entry => optional workout summary string
 *   now, baseUrl, timeZone
 * @returns report {created, updated, moved, unchanged, deleted, adopted, unscheduled, errors}
 */
async function syncPlan(plan, options = {}) {
    const {
        client,
        prefs = {},
        updateEntry = async () => {},
        calendarId = 'primary',
        horizonDays = 28,
        reminderMin = 15,
        describe,
        baseUrl,
        timeZone = localTimeZone(),
    } = options;
    const busyCalendarIds = options.busyCalendarIds ?? Array.from(new Set([calendarId, 'primary']));
    const now = options.now ? new Date(options.now) : new Date();

    const report = {created: [], updated: [], moved: [], unchanged: [], deleted: [],
                    adopted: [], unscheduled: [], errors: []};
    if(!client) throw new Error('syncPlan needs a client');
    if(!plan) return report;

    const entries = plan.entries ?? [];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const shift = Math.max(0, (prefs.maxShiftDays ?? 1) | 0);
    const todayStr = formatDate(today);
    const endStr = formatDate(addDays(today, horizonDays));
    const timeMin = addDays(today, -shift);
    const timeMax = addDays(today, horizonDays + shift + 1);

    const patchEntry = async (entry, patch) => {
        const diff = Object.keys(patch).some(k => (entry[k] ?? null) !== (patch[k] ?? null));
        if(!diff) return;
        Object.assign(entry, patch);
        await updateEntry(plan.id, entry.id, patch);
    };

    // 1. our own events for this plan
    const own = await client.listEvents(calendarId, {
        timeMin, timeMax, privateExtendedProperty: `fluxPlanId=${plan.id}`,
    });
    const byEntry = new Map();
    for(const ev of own) {
        if(ev.status === 'cancelled') continue;
        const id = ev.extendedProperties?.private?.fluxEntryId;
        if(id) byEntry.set(id, ev);
    }

    const active = entries.filter(e => isActive(e, todayStr, endStr));
    const activeIds = new Set(active.map(e => String(e.id)));

    // 2. decide keep / move / schedule
    const kept = [];
    const toSchedule = [];
    const existingFor = new Map();
    for(const entry of active) {
        let ev = byEntry.get(String(entry.id));
        if(!ev && entry.calendarEventId) {
            ev = await client.getEvent(calendarId, entry.calendarEventId);
            if(ev?.status === 'cancelled') ev = null;
        }
        if(ev) existingFor.set(entry.id, ev);

        const start = eventStart(ev);
        if(!start) { toSchedule.push(entry); continue; }

        const evDate = formatDate(start);
        const syncedDate = ev.extendedProperties?.private?.fluxEntryDate;

        if(syncedDate && syncedDate === entry.date && evDate !== entry.date) {
            // rider dragged the event to another day in the calendar: adopt it
            await patchEntry(entry, {date: evDate});
            report.adopted.push(entry.id);
            kept.push({entry, ev});
        } else if(evDate === entry.date) {
            kept.push({entry, ev});
        } else {
            // the plan moved the ride: re-place it
            toSchedule.push(entry);
        }
    }

    // 3. keep: refresh text only when it changed
    for(const {entry, ev} of kept) {
        try {
            const body = buildEventBody({plan, entry, reminderMin, describe, baseUrl, timeZone});
            if(needsTextPatch(ev, body)) {
                await client.patchEvent(calendarId, ev.id, body);
                report.updated.push(entry.id);
            } else {
                report.unchanged.push(entry.id);
            }
            await patchEntry(entry, {calendarEventId: ev.id});
        } catch (err) {
            report.errors.push({entryId: entry.id, error: err.message});
        }
    }

    // 4. schedule the rest against free/busy
    if(toSchedule.length) {
        const moving = new Set(toSchedule.map(e => existingFor.get(e.id)).filter(Boolean));
        const movingIntervals = [...moving].map(ev => [eventStart(ev)?.getTime(), eventEnd(ev)?.getTime()]);
        const busy = (await client.freeBusy({timeMin, timeMax, calendarIds: busyCalendarIds}))
            .filter(b => !movingIntervals.some(([s, e]) =>
                new Date(b.start).getTime() === s && new Date(b.end).getTime() === e));

        const fixed = kept.map(({entry, ev}) => ({
            start: eventStart(ev), end: eventEnd(ev) ?? eventStart(ev), hard: isHardEntry(entry),
        })).filter(f => f.start);

        const results = scheduleEntries(toSchedule, prefs, {busy, now, fixed});

        for(const r of results) {
            const entry = r.entry;
            if(!r.start) {
                report.unscheduled.push({entryId: entry.id, reason: r.reason});
                continue;
            }
            try {
                const datePatch = r.date !== entry.date ? {date: r.date} : {};
                const body = buildEventBody({
                    plan, entry: {...entry, ...datePatch}, start: r.start, end: r.end,
                    reminderMin, describe, baseUrl, timeZone,
                });
                const ev = existingFor.get(entry.id);
                let saved;
                if(ev) {
                    saved = await client.patchEvent(calendarId, ev.id, body);
                    report.moved.push(entry.id);
                } else {
                    const id = eventIdFor(plan.id, entry.id);
                    try {
                        saved = await client.insertEvent(calendarId, {id, ...body});
                        report.created.push(entry.id);
                    } catch (err) {
                        if(err.status !== 409) throw err;
                        // already exists (e.g. previously deleted, or saved id lost): revive
                        saved = await client.patchEvent(calendarId, id, {...body, status: 'confirmed'});
                        report.updated.push(entry.id);
                    }
                }
                await patchEntry(entry, {calendarEventId: saved?.id ?? ev?.id, ...datePatch});
            } catch (err) {
                report.errors.push({entryId: entry.id, error: err.message});
            }
        }
    }

    // 5. delete events whose entry is gone or skipped
    const byId = new Map(entries.map(e => [String(e.id), e]));
    for(const [entryId, ev] of byEntry) {
        if(activeIds.has(entryId)) continue;
        const entry = byId.get(entryId);
        // only remove events for entries that were removed or skipped;
        // done / missed / out-of-horizon rides keep their event
        if(entry && entry.status !== 'skipped') continue;
        try {
            await client.deleteEvent(calendarId, ev.id);
            report.deleted.push(entryId);
            if(entry) await patchEntry(entry, {calendarEventId: null});
        } catch (err) {
            report.errors.push({entryId, error: err.message});
        }
    }
    for(const entry of entries) {
        if(entry.status === 'skipped' && entry.calendarEventId && !byEntry.has(String(entry.id))) {
            try {
                await client.deleteEvent(calendarId, entry.calendarEventId);
                report.deleted.push(entry.id);
                await patchEntry(entry, {calendarEventId: null});
            } catch (err) {
                report.errors.push({entryId: entry.id, error: err.message});
            }
        }
    }

    return report;
}

// Remove every event this plan created (e.g. plan deleted / user disconnects)
async function unsyncPlan(plan, {client, calendarId = 'primary', updateEntry = async () => {}} = {}) {
    const own = await client.listEvents(calendarId, {privateExtendedProperty: `fluxPlanId=${plan.id}`});
    for(const ev of own) {
        if(ev.status === 'cancelled') continue;
        await client.deleteEvent(calendarId, ev.id);
    }
    for(const entry of plan.entries ?? []) {
        if(entry.calendarEventId) await updateEntry(plan.id, entry.id, {calendarEventId: null});
    }
    return own.length;
}

export { syncPlan, unsyncPlan, buildEventBody, eventStart };
