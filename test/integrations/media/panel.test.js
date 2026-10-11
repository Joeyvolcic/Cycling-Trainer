/**
 * @jest-environment jsdom
 */
import { xf } from '../../../src/functions.js';
import '../../../src/integrations/media/panel.js';
import '../../../src/integrations/media/settings.js';
import * as ride from '../../../src/integrations/media/ride.js';

describe('<x-media-panel> smoke', () => {
    beforeEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

    test('renders setup hint when Spotify is not configured', () => {
        const panel = document.createElement('x-media-panel');
        document.body.appendChild(panel);
        expect(panel.querySelectorAll('.mp-tabs button')).toHaveLength(5);
        expect(panel.textContent).toMatch(/Spotify is not set up/);
        panel.remove();
    });

    test('tabs switch and touch targets are present', () => {
        const panel = document.createElement('x-media-panel');
        document.body.appendChild(panel);
        panel.querySelector('[data-tab="local"]').click();
        expect(panel.querySelector('[data-ref="feed-url"]')).not.toBeNull();
        panel.querySelector('[data-tab="ride"]').click();
        expect(panel.textContent).toMatch(/Intensity playlists/);
        panel.remove();
    });

    test('shows connect button once a client id is set', () => {
        localStorage.setItem('media:spotify-client-id', 'abc');
        const panel = document.createElement('x-media-panel');
        document.body.appendChild(panel);
        expect(panel.querySelector('[data-action="login"]')).not.toBeNull();
        panel.remove();
    });

    test('settings shows the redirect URI to register', () => {
        const settings = document.createElement('x-media-settings');
        document.body.appendChild(settings);
        expect(settings.textContent).toContain(`${location.origin}${location.pathname}`);
        settings.remove();
    });

    test('ride controller plans segments from db events', () => {
        ride.start();
        xf.dispatch('db:ftp', {ftp: 250});
        xf.dispatch('db:workout', {workout: {intervals: [
            {duration: 300, steps: [{duration: 300, power: 0.5}]},
            {duration: 300, steps: [{duration: 300, power: 1.0}]},
        ]}});
        expect(ride.getPlan()).toEqual(['warmup', 'threshold']);
    });
});
