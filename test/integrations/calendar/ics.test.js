import { toIcs, escapeText, fold } from '../../../src/integrations/calendar/ics.js';
import { deepLink, eventDescription, formatDuration } from '../../../src/integrations/calendar/event.js';

const now = new Date(Date.UTC(2026, 9, 11, 12, 0, 0));

describe('event helpers', () => {
    test('deepLink', () => {
        expect(deepLink({id: 'e 1', workoutId: 42}, 'p1', 'https://app.test/flux/'))
            .toBe('https://app.test/flux/?planEntry=e+1&plan=p1&workout=42');
        expect(deepLink({id: 'e1'}, undefined, 'http://localhost:1234/'))
            .toBe('http://localhost:1234/?planEntry=e1');
    });

    test('formatDuration', () => {
        expect(formatDuration(45)).toBe('45min');
        expect(formatDuration(60)).toBe('1h');
        expect(formatDuration(90)).toBe('1h 30min');
        expect(formatDuration(undefined)).toBe('');
    });

    test('eventDescription', () => {
        const d = eventDescription({workoutName: 'VO2', durationMin: 60, notes: 'n'},
                                   {planName: 'P', summary: 's', link: 'L'});
        expect(d).toBe('VO2 (1h)\nPlan: P\n\ns\n\nn\n\nOpen in app: L');
    });
});

describe('ics', () => {
    test('escapeText', () => {
        expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    });

    test('fold keeps lines <= 75 octets', () => {
        const long = 'DESCRIPTION:' + 'x'.repeat(200);
        const folded = fold(long).split('\r\n');
        expect(folded.length).toBeGreaterThan(2);
        folded.forEach(l => expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75));
        expect(folded.slice(1).every(l => l.startsWith(' '))).toBe(true);
        expect(folded.map((l, i) => i ? l.slice(1) : l).join('')).toBe(long);
    });

    test('timed and all-day events with alarm', () => {
        const start = new Date(Date.UTC(2026, 9, 12, 5, 0));
        const end = new Date(Date.UTC(2026, 9, 12, 6, 0));
        const text = toIcs([
            {entry: {id: 'e1', date: '2026-10-12', workoutName: 'Sweet Spot, 3x15', durationMin: 60, status: 'planned'},
             planId: 'p1', planName: 'Base', start, end},
            {entry: {id: 'e2', date: '2026-10-14', workoutName: 'Endurance', status: 'planned'}, planId: 'p1'},
        ], {now, baseUrl: 'https://app.test/'});

        expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
        expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
        expect(text.match(/BEGIN:VEVENT/g).length).toBe(2);
        expect(text).toContain('UID:e1.p1@flux-plan');
        expect(text).toContain('DTSTART:20261012T050000Z');
        expect(text).toContain('DTEND:20261012T060000Z');
        expect(text).toContain('SUMMARY:Sweet Spot\\, 3x15');
        expect(text).toContain('DTSTART;VALUE=DATE:20261014');
        expect(text).toContain('DTEND;VALUE=DATE:20261015');
        expect(text).toContain('TRIGGER:-PT15M');
        expect(text).toContain('URL:https://app.test/?planEntry=e1&plan=p1');
        expect(text).toContain('DTSTAMP:20261011T120000Z');
        expect(text.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75)).toBe(true);
    });

    test('no alarm when reminderMin is 0', () => {
        const text = toIcs([{entry: {id: 'e', date: '2026-10-12'}, planId: 'p'}], {now, reminderMin: 0});
        expect(text).not.toContain('VALARM');
    });
});
