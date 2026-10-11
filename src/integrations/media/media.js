//
// Media integration entry: music, podcasts and audiobooks while riding.
// See doc/media.md for setup (Spotify app, redirect URI, Premium, iPad notes).
//

import { registerPanel } from '../registry.js';
import * as auth from './spotify-auth.js';
import * as session from './session.js';
import * as ride from './ride.js';
import './panel.js';
import './settings.js';

function start() {
    auth.start();
    session.start();
    ride.start();

    // Spotify redirects back with ?code=...&state=spotify_...
    auth.handleCallback(window.location.search).then(handled => {
        if(handled) console.log(':media :spotify :callback handled');
    });

    registerPanel({
        id:      'media',
        title:   'Music & Podcasts',
        icon:    'music',
        element: document.createElement('x-media-panel'),
    });
}

start();

export { start };
