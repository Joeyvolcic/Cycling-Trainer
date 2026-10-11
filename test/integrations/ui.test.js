/**
 * @jest-environment jsdom
 */

import {
    LAYOUTS, DEFAULT_LAYOUT, STORAGE_KEY,
    isValidLayout, restoreLayout, backupLayout, focusExpanded, nextLayout,
} from '../../src/integrations/ui/layout.js';
import { createPanelElement, pickActive } from '../../src/integrations/ui/dock.js';
import { isIOS, isIPad, isStandalone, capabilities, guidance } from '../../src/integrations/ui/platform.js';
import { todaysPlanned } from '../../src/integrations/ui/quick-start.js';

function memoryStorage(init = {}) {
    const data = {...init};
    return {
        getItem: k => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); },
        data,
    };
}

describe('layout setting', () => {
    test('classic is the default', () => {
        expect(DEFAULT_LAYOUT).toBe('classic');
        expect(restoreLayout(memoryStorage())).toBe('classic');
    });
    test('restores a valid stored layout, rejects junk', () => {
        expect(restoreLayout(memoryStorage({[STORAGE_KEY]: 'split'}))).toBe('split');
        expect(restoreLayout(memoryStorage({[STORAGE_KEY]: 'nope'}))).toBe('classic');
    });
    test('survives a throwing storage (private mode)', () => {
        const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
        expect(restoreLayout(storage)).toBe('classic');
        expect(() => backupLayout('banner', storage)).not.toThrow();
    });
    test('backup writes the key', () => {
        const storage = memoryStorage();
        backupLayout('focus', storage);
        expect(storage.data[STORAGE_KEY]).toBe('focus');
    });
    test('has the four layouts and cycles through them', () => {
        expect(LAYOUTS.map(l => l.id)).toEqual(['classic', 'banner', 'split', 'focus']);
        expect(isValidLayout('banner')).toBe(true);
        expect(nextLayout('classic')).toBe('banner');
        expect(nextLayout('focus')).toBe('classic');
        expect(nextLayout('unknown')).toBe('classic');
    });
});

describe('focus mode', () => {
    const now = 1_000_000;
    const riding = {running: true, workout: true, intervalDuration: 300, now};

    test('expanded when not riding', () => {
        expect(focusExpanded({running: false, now})).toBe(true);
    });
    test('collapsed mid-interval', () => {
        expect(focusExpanded({...riding, lapTime: 200})).toBe(false);
    });
    test('expands before the interval ends', () => {
        expect(focusExpanded({...riding, lapTime: 20})).toBe(true);
        expect(focusExpanded({...riding, lapTime: 5})).toBe(true);
    });
    test('stays expanded for the first seconds of a new interval', () => {
        expect(focusExpanded({...riding, lapTime: 295})).toBe(true);
        expect(focusExpanded({...riding, lapTime: 289})).toBe(false);
    });
    test('free ride (no workout) stays collapsed while riding', () => {
        expect(focusExpanded({running: true, workout: false, lapTime: 3, now})).toBe(false);
    });
    test('user pin keeps it expanded until it expires', () => {
        expect(focusExpanded({...riding, lapTime: 200, pinnedUntil: now + 1000})).toBe(true);
        expect(focusExpanded({...riding, lapTime: 200, pinnedUntil: now - 1})).toBe(false);
    });
});

describe('integrations dock', () => {
    test('creates panels from a tag name', () => {
        const el = createPanelElement('x-test-panel');
        expect(el.tagName).toBe('X-TEST-PANEL');
    });
    test('accepts an element instance', () => {
        const div = document.createElement('div');
        expect(createPanelElement(div)).toBe(div);
    });
    test('accepts a custom element class and a factory', () => {
        class XFoo extends HTMLElement {}
        customElements.define('x-foo-panel', XFoo);
        expect(createPanelElement(XFoo)).toBeInstanceOf(XFoo);
        const made = document.createElement('section');
        expect(createPanelElement(() => made)).toBe(made);
    });
    test('missing element -> undefined', () => {
        expect(createPanelElement(undefined)).toBeUndefined();
    });
    test('pickActive keeps the preferred panel or falls back to the first', () => {
        const panels = [{id: 'media'}, {id: 'quiz'}];
        expect(pickActive(panels, 'quiz')).toBe('quiz');
        expect(pickActive(panels, 'gone')).toBe('media');
        expect(pickActive([], 'quiz')).toBeUndefined();
    });
});

describe('platform detection', () => {
    const ipadSafari = {
        navigator: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
            platform: 'MacIntel',
            maxTouchPoints: 5,
            wakeLock: {},
        },
        window: { matchMedia: () => ({matches: false}), location: {host: 'example.com'} },
    };
    const mac = {
        navigator: {...ipadSafari.navigator, maxTouchPoints: 0},
        window: ipadSafari.window,
    };
    const bluefy = {
        navigator: {
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Bluefy',
            platform: 'iPad', maxTouchPoints: 5, bluetooth: {},
        },
        window: ipadSafari.window,
    };
    const chrome = {
        navigator: {userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', bluetooth: {}, usb: {}, serial: {}, maxTouchPoints: 0},
        window: ipadSafari.window,
    };

    test('iPadOS Safari (desktop UA) is detected as iPad', () => {
        expect(isIOS(ipadSafari)).toBe(true);
        expect(isIPad(ipadSafari)).toBe(true);
        expect(isIOS(mac)).toBe(false);
    });
    test('standalone via navigator.standalone', () => {
        expect(isStandalone({navigator: {standalone: true}, window: {}})).toBe(true);
        expect(isStandalone(ipadSafari)).toBe(false);
    });
    test('iPad Safari without Web Bluetooth gets Bluefy guidance', () => {
        expect(capabilities(ipadSafari).bluetooth).toBe(false);
        const g = guidance(ipadSafari);
        expect(g.level).toBe('error');
        expect(g.html).toMatch(/Bluefy/);
        expect(g.html).toMatch(/example\.com/);
    });
    test('Bluefy on iPad is ok but warns about ANT+', () => {
        const g = guidance(bluefy);
        expect(g.level).toBe('ok');
        expect(g.html).toMatch(/ANT\+/);
    });
    test('desktop Chrome is ok', () => {
        expect(guidance(chrome).level).toBe('ok');
        expect(capabilities(chrome)).toMatchObject({bluetooth: true, usb: true, serial: true});
    });
});

describe('quick start', () => {
    test("finds today's planned workout", () => {
        const today = new Date().toISOString();
        const planned = [
            {id: 'a', meta: {name: 'Old', startDateLocal: '2001-01-01T00:00:00'}},
            {id: 'b', meta: {name: 'Today', startDateLocal: today}},
        ];
        expect(todaysPlanned(planned).id).toBe('b');
        expect(todaysPlanned([])).toBeUndefined();
    });
});
