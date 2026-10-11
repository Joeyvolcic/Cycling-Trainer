//
// Spotify session: profile, now-playing polling, device selection and playback actions.
// Dispatches xf 'media:spotify' with the current state.
//

import { xf } from '../../functions.js';
import * as auth from './spotify-auth.js';
import * as api from './spotify-api.js';
import * as web from './web-playback.js';
import { toNowPlaying, liveProgress } from './model.js';
import { getPrefs } from './store.js';

const POLL_MS = 4000;

const state = {
    profile:  null,     // GET /me
    premium:  null,     // true | false | null (unknown)
    np:       toNowPlaying(null),
    devices:  [],
    error:    '',
    loading:  false,
};

let pollTimer = null;
let pokeTimer = null;

function emit() { xf.dispatch('media:spotify', snapshot()); }
function snapshot() { return Object.assign({}, state, {loggedIn: auth.isLoggedIn()}); }

function setError(msg) {
    state.error = msg || '';
    emit();
}

async function loadProfile() {
    try {
        state.profile = await api.me();
        state.premium = state.profile?.product === 'premium';
    } catch(err) {
        state.profile = null;
        state.premium = null;
        state.error   = err.message;
    }
    emit();
    return state.profile;
}

async function refresh() {
    if(!auth.isLoggedIn()) return;
    try {
        const playback = await api.playbackState();
        state.np = toNowPlaying(playback, Date.now());
        if(state.error && /device|rate/i.test(state.error)) state.error = '';
    } catch(err) {
        state.error = err.message;
    }
    emit();
}

async function refreshDevices() {
    if(!auth.isLoggedIn()) return [];
    try {
        state.devices = await api.devices();
    } catch(err) {
        state.error = err.message;
    }
    emit();
    return state.devices;
}

function poke(delay = 400) {
    clearTimeout(pokeTimer);
    pokeTimer = setTimeout(refresh, delay);
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
        if(document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    refresh();
}

function stopPolling() {
    if(pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

// Pick the device to target when nothing is active:
// web player (desktop) > active device > iPad/phone running Spotify > anything
async function targetDevice() {
    if(state.np?.device?.id) return state.np.device.id;
    const devices = await refreshDevices();
    const active = devices.find(d => d.is_active);
    if(active) return active.id;
    const webId = web.getDeviceId();
    if(webId) return webId;
    const pick = devices.find(d => !d.is_restricted && /tablet|smartphone/i.test(d.type)) ||
                 devices.find(d => !d.is_restricted);
    return pick ? pick.id : undefined;
}

async function guarded(fn) {
    try {
        const out = await fn();
        state.error = '';
        poke();
        return out;
    } catch(err) {
        setError(err.message);
        return null;
    }
}

// --- actions ----------------------------------------------------------------

async function togglePlay() {
    web.activate();
    if(state.np.isPlaying) {
        state.np = Object.assign({}, state.np, {isPlaying: false, progressMs: liveProgress(state.np), fetchedAt: Date.now()});
        emit();
        return guarded(() => api.pause());
    }
    const deviceId = await targetDevice();
    state.np = Object.assign({}, state.np, {isPlaying: true, fetchedAt: Date.now()});
    emit();
    return guarded(() => api.play({deviceId}));
}

async function pause() {
    if(!state.np.isPlaying) return null;
    state.np = Object.assign({}, state.np, {isPlaying: false, progressMs: liveProgress(state.np), fetchedAt: Date.now()});
    emit();
    return guarded(() => api.pause());
}

async function resume() {
    const deviceId = await targetDevice();
    return guarded(() => api.play({deviceId}));
}

const next     = () => guarded(() => api.next());
const previous = () => guarded(() => api.previous());

function seekTo(ms) {
    state.np = Object.assign({}, state.np, {progressMs: ms, fetchedAt: Date.now()});
    emit();
    return guarded(() => api.seek(ms));
}

function skipBy(seconds) {
    const target = liveProgress(state.np) + seconds * 1000;
    const max = state.np.durationMs || target;
    return seekTo(Math.max(0, Math.min(max, target)));
}

function setVolume(percent) {
    return guarded(() => api.volume(percent));
}

function transferTo(deviceId) {
    web.activate();
    return guarded(() => api.transfer(deviceId, true));
}

// {contextUri?, uris?, offsetUri?, positionMs?}
async function playItem(opts = {}) {
    web.activate();
    const deviceId = await targetDevice();
    return guarded(() => api.play(Object.assign({deviceId}, opts)));
}

async function start() {
    xf.sub('media:poke', () => poke(300));
    xf.sub('media:auth', async (s) => {
        if(s && s.loggedIn) { await onLoggedIn(); }
        else { stopPolling(); web.disconnect(); state.profile = null; state.np = toNowPlaying(null); emit(); }
    });
    if(auth.isLoggedIn()) await onLoggedIn();
}

async function onLoggedIn() {
    await loadProfile();
    startPolling();
    const prefs = getPrefs();
    if(prefs.useWebPlayer && web.support().supported) {
        try { await web.connect({product: state.profile?.product}); }
        catch(err) { setError(err.message); }
    }
}

export {
    state,
    snapshot,
    refresh,
    refreshDevices,
    loadProfile,
    togglePlay,
    pause,
    resume,
    next,
    previous,
    seekTo,
    skipBy,
    setVolume,
    transferTo,
    playItem,
    start,
};
