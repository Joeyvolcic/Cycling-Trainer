//
// Pure helpers shared by the Google sync and the .ics export:
// deep links back into the app, event text, deterministic event ids.
//

const APP_TAG = 'flux-plan';

function appBaseUrl() {
    if(typeof window !== 'undefined' && window.location) {
        return `${window.location.origin}${window.location.pathname}`;
    }
    return '';
}

// e.g. https://host/?planEntry=<entryId>&plan=<planId>&workout=<workoutId>
function deepLink(entry = {}, planId, base = appBaseUrl()) {
    const url = new URL(base || 'http://localhost/');
    if(entry.id) url.searchParams.set('planEntry', entry.id);
    if(planId) url.searchParams.set('plan', planId);
    if(entry.workoutId !== undefined && entry.workoutId !== null && entry.workoutId !== '') {
        url.searchParams.set('workout', entry.workoutId);
    }
    return url.toString();
}

function eventTitle(entry = {}) {
    return entry.workoutName || 'Training ride';
}

function formatDuration(min) {
    const m = Math.round(Number(min) || 0);
    if(!m) return '';
    const h = Math.floor(m / 60);
    return h ? `${h}h${m % 60 ? ` ${m % 60}min` : ''}` : `${m}min`;
}

// `summary` is an optional string from the workout itself (e.g. its description)
function eventDescription(entry = {}, {planName, summary, link} = {}) {
    const lines = [];
    const dur = formatDuration(entry.durationMin);
    lines.push(`${eventTitle(entry)}${dur ? ` (${dur})` : ''}`);
    if(planName) lines.push(`Plan: ${planName}`);
    if(summary) lines.push('', summary);
    if(entry.notes) lines.push('', entry.notes);
    if(link) lines.push('', `Open in app: ${link}`);
    return lines.join('\n');
}

// Google Calendar event ids: 5-1024 chars from base32hex [a-v0-9].
// Hex encoding of the utf-8 bytes is a subset of that, and deterministic,
// which makes inserts idempotent (409 on the second insert).
function utf8Bytes(str) {
    // TextEncoder is not available in every test environment
    const out = [];
    for(const ch of String(str)) {
        const c = ch.codePointAt(0);
        if(c < 0x80) out.push(c);
        else if(c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if(c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}

function eventIdFor(planId, entryId) {
    const bytes = utf8Bytes(`${planId}:${entryId}`);
    let hex = '';
    for(const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `fp${hex}`.slice(0, 1024);
}

export { utf8Bytes, APP_TAG, deepLink, eventTitle, eventDescription, eventIdFor, formatDuration, appBaseUrl };
