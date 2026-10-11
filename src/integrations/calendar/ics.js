//
// iCalendar (.ics) export — the no-OAuth fallback (works with Apple Calendar on iPad).
//

import { eventTitle, eventDescription, deepLink, utf8Bytes, APP_TAG } from './event.js';
import { parseDate, formatDate, addDays } from './scheduler.js';

function pad(n) { return String(n).padStart(2, '0'); }

function utcStamp(date) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
           `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function dateValue(date) {
    return formatDate(date).replace(/-/g, '');
}

function escapeText(str = '') {
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n');
}

// RFC 5545: lines SHOULD NOT be longer than 75 octets; continuation lines start with a space
function fold(line) {
    if(utf8Bytes(line).length <= 75) return line;
    const out = [];
    let cur = '';
    let len = 0;
    for(const ch of line) {
        const n = utf8Bytes(ch).length;
        const limit = out.length === 0 ? 75 : 74;
        if(len + n > limit) {
            out.push(cur);
            cur = '';
            len = 0;
        }
        cur += ch;
        len += n;
    }
    out.push(cur);
    return out.join('\r\n ');
}

/**
 * @param {Array} items [{entry, planId, planName, start?: Date, end?: Date, summary?}]
 *   entries without start/end become all-day events on entry.date.
 * @param {Object} opts {calendarName, reminderMin = 15, now, baseUrl}
 * @returns {string} VCALENDAR text with CRLF line endings
 */
function toIcs(items = [], opts = {}) {
    const {calendarName = 'Training', reminderMin = 15, now = new Date(), baseUrl} = opts;
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Flux//Training Plan//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeText(calendarName)}`,
    ];
    for(const item of items) {
        const {entry, planId, planName, start, end, summary} = item;
        if(!entry) continue;
        const link = deepLink(entry, planId, baseUrl);
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${entry.id}.${planId ?? 'plan'}@${APP_TAG}`);
        lines.push(`DTSTAMP:${utcStamp(now)}`);
        // SEQUENCE grows with time so re-imports update rather than duplicate
        lines.push(`SEQUENCE:${Math.floor(now.getTime() / 1000)}`);
        if(start && end) {
            lines.push(`DTSTART:${utcStamp(start)}`);
            lines.push(`DTEND:${utcStamp(end)}`);
        } else {
            const day = parseDate(entry.date);
            lines.push(`DTSTART;VALUE=DATE:${dateValue(day)}`);
            lines.push(`DTEND;VALUE=DATE:${dateValue(addDays(day, 1))}`);
        }
        lines.push(`SUMMARY:${escapeText(eventTitle(entry))}`);
        lines.push(`DESCRIPTION:${escapeText(eventDescription(entry, {planName, summary, link}))}`);
        lines.push(`URL:${link}`);
        lines.push('CATEGORIES:Training');
        if(entry.status === 'skipped') lines.push('STATUS:CANCELLED');
        if(reminderMin > 0) {
            lines.push('BEGIN:VALARM');
            lines.push('ACTION:DISPLAY');
            lines.push(`DESCRIPTION:${escapeText(eventTitle(entry))}`);
            lines.push(`TRIGGER:-PT${reminderMin}M`);
            lines.push('END:VALARM');
        }
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
}

export { toIcs, escapeText, fold, utcStamp };
