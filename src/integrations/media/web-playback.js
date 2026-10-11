//
// Spotify Web Playback SDK (desktop browsers only, Premium only).
// Registers this browser tab as a Spotify Connect device named "Flux Trainer";
// all control then goes through the same Connect Web API as on iPad.
//

import { xf } from '../../functions.js';
import { getAccessToken } from './spotify-auth.js';
import { webPlaybackSupport } from './model.js';

const SDK_URL     = 'https://sdk.scdn.co/spotify-player.js';
const DEVICE_NAME = 'Flux Trainer';

let player   = null;
let deviceId = null;
let sdkPromise = null;
let lastError = '';

function support() {
    return webPlaybackSupport({
        userAgent:      navigator.userAgent,
        platform:       navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints || 0,
        hasEME:         typeof navigator.requestMediaKeySystemAccess === 'function',
    });
}

function loadSdk() {
    if(sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
        if(window.Spotify && window.Spotify.Player) return resolve(window.Spotify);
        window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
        const script = document.createElement('script');
        script.src = SDK_URL;
        script.async = true;
        script.onerror = () => { sdkPromise = null; reject(new Error('Could not load the Spotify Web Playback SDK.')); };
        document.head.appendChild(script);
    });
    return sdkPromise;
}

function emit() {
    xf.dispatch('media:webplayer', {deviceId, error: lastError, ready: !!deviceId, name: DEVICE_NAME});
}

// product: 'premium' | 'free' | ... from GET /me
async function connect({product} = {}) {
    const s = support();
    if(!s.supported) { lastError = s.message; emit(); return null; }
    if(product && product !== 'premium') {
        lastError = 'In-browser playback needs Spotify Premium. You can still browse; playback control also needs Premium.';
        emit();
        return null;
    }
    if(player) return deviceId;

    const Spotify = await loadSdk();
    player = new Spotify.Player({
        name: DEVICE_NAME,
        getOAuthToken: cb => { getAccessToken().then(cb).catch(() => cb('')); },
        volume: 0.8,
    });
    player.addListener('ready', ({device_id}) => { deviceId = device_id; lastError = ''; emit(); });
    player.addListener('not_ready', () => { deviceId = null; emit(); });
    player.addListener('initialization_error', ({message}) => { lastError = `Web player unsupported here: ${message}`; emit(); });
    player.addListener('authentication_error', ({message}) => { lastError = `Web player auth error: ${message}`; emit(); });
    player.addListener('account_error', () => { lastError = 'In-browser playback needs Spotify Premium.'; emit(); });
    player.addListener('playback_error', ({message}) => { xf.dispatch('media:error', `Playback error: ${message}`); });
    player.addListener('player_state_changed', () => xf.dispatch('media:poke'));
    await player.connect();
    return deviceId;
}

// Must be called from a user gesture (click) so the browser lets audio start
function activate() {
    try { player?.activateElement?.(); } catch(e) { /* older SDK */ }
}

function disconnect() {
    if(player) player.disconnect();
    player = null;
    deviceId = null;
    emit();
}

function getDeviceId() { return deviceId; }
function getError() { return lastError; }

export { support, connect, activate, disconnect, getDeviceId, getError, DEVICE_NAME };
