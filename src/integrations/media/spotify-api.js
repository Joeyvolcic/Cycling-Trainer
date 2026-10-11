//
// Spotify Web API client (Connect playback control + library + search).
// Note: all /me/player write endpoints require Spotify Premium.
//

import { getAccessToken } from './spotify-auth.js';

const API = 'https://api.spotify.com/v1';

class SpotifyError extends Error {
    constructor(message, {status = 0, reason = ''} = {}) {
        super(message);
        this.name   = 'SpotifyError';
        this.status = status;
        this.reason = reason; // e.g. NO_ACTIVE_DEVICE, PREMIUM_REQUIRED
    }
}

function explain(status, reason, message) {
    if(reason === 'PREMIUM_REQUIRED' || (status === 403 && /premium/i.test(message))) {
        return 'Controlling playback requires Spotify Premium.';
    }
    if(reason === 'NO_ACTIVE_DEVICE' || (status === 404 && /device/i.test(message))) {
        return 'No active Spotify device. Open the Spotify app (or pick a device) and try again.';
    }
    if(status === 429) return 'Spotify rate limit hit, slow down a moment.';
    return message || `Spotify request failed (${status})`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, {query, body, retry = true} = {}) {
    const url = new URL(path.startsWith('http') ? path : API + path);
    if(query) {
        Object.entries(query).forEach(([k, v]) => {
            if(v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
        });
    }
    const token = await getAccessToken();
    const res = await fetch(url.toString(), {
        method,
        headers: Object.assign(
            {Authorization: `Bearer ${token}`},
            body !== undefined ? {'Content-Type': 'application/json'} : {}
        ),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if(res.status === 401 && retry) {
        await getAccessToken({force: true});
        return request(method, path, {query, body, retry: false});
    }
    if(res.status === 429 && retry) {
        const wait = Math.min(10, Number(res.headers.get('Retry-After')) || 1);
        await sleep(wait * 1000);
        return request(method, path, {query, body, retry: false});
    }
    if(res.status === 204 || res.status === 202) return null;

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch(e) { json = null; }

    if(!res.ok) {
        const message = json?.error?.message || text || res.statusText;
        const reason  = json?.error?.reason || '';
        throw new SpotifyError(explain(res.status, reason, message), {status: res.status, reason});
    }
    return json;
}

const get  = (p, query)       => request('GET',  p, {query});
const put  = (p, query, body) => request('PUT',  p, {query, body});
const post = (p, query, body) => request('POST', p, {query, body});

// Profile
const me = () => get('/me');

// Player (Spotify Connect)
const playbackState = () => get('/me/player', {additional_types: 'track,episode', market: 'from_token'});
const devices       = async () => (await get('/me/player/devices'))?.devices || [];
const transfer      = (deviceId, play = true) => put('/me/player', null, {device_ids: [deviceId], play});
const pause         = (deviceId) => put('/me/player/pause', {device_id: deviceId});
const next          = (deviceId) => post('/me/player/next', {device_id: deviceId});
const previous      = (deviceId) => post('/me/player/previous', {device_id: deviceId});
const seek          = (positionMs, deviceId) => put('/me/player/seek', {position_ms: Math.max(0, Math.round(positionMs)), device_id: deviceId});
const volume        = (percent, deviceId) => put('/me/player/volume', {volume_percent: Math.max(0, Math.min(100, Math.round(percent))), device_id: deviceId});
const shuffle       = (state, deviceId) => put('/me/player/shuffle', {state: !!state, device_id: deviceId});

// play({contextUri, uris, offsetUri, offsetPosition, positionMs, deviceId}); no args = resume
function play({contextUri, uris, offsetUri, offsetPosition, positionMs, deviceId} = {}) {
    const body = {};
    if(contextUri) body.context_uri = contextUri;
    if(uris)       body.uris = uris;
    if(offsetUri)  body.offset = {uri: offsetUri};
    else if(Number.isInteger(offsetPosition)) body.offset = {position: offsetPosition};
    if(positionMs) body.position_ms = Math.max(0, Math.round(positionMs));
    return put('/me/player/play', {device_id: deviceId}, Object.keys(body).length ? body : undefined);
}

// Library
const playlists      = (offset = 0) => get('/me/playlists', {limit: 50, offset});
const savedShows     = (offset = 0) => get('/me/shows', {limit: 50, offset});
const showEpisodes   = (showId, offset = 0) => get(`/shows/${showId}/episodes`, {limit: 50, offset, market: 'from_token'});
const savedEpisodes  = (offset = 0) => get('/me/episodes', {limit: 50, offset, market: 'from_token'});
const savedAudiobooks = (offset = 0) => get('/me/audiobooks', {limit: 50, offset});
const audiobookChapters = (bookId, offset = 0) => get(`/audiobooks/${bookId}/chapters`, {limit: 50, offset, market: 'from_token'});

function search(q, types = ['track', 'playlist', 'show', 'episode', 'audiobook'], limit = 10) {
    return get('/search', {q, type: types.join(','), limit, market: 'from_token'});
}

export {
    SpotifyError,
    request,
    me,
    playbackState,
    devices,
    transfer,
    play,
    pause,
    next,
    previous,
    seek,
    volume,
    shuffle,
    playlists,
    savedShows,
    showEpisodes,
    savedEpisodes,
    savedAudiobooks,
    audiobookChapters,
    search,
};
