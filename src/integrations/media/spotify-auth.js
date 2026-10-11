//
// Spotify login: Authorization Code + PKCE, entirely in the browser.
// The user registers their own Spotify app and pastes its Client ID in Settings.
//

import { xf } from '../../functions.js';
import {
    SPOTIFY_TOKEN_URL, generateVerifier, randomString, codeChallenge,
    buildAuthorizeUrl, tokenRequestBody, refreshRequestBody, parseCallback, redirectUriFor,
} from './pkce.js';
import {
    normalizeTokenResponse, isExpired, isFatalRefreshError, singleFlight, createRefreshScheduler,
} from './tokens.js';
import { KEYS, lsGet, lsSet, lsGetJSON, lsSetJSON } from './store.js';

const STATE_PREFIX = 'spotify_'; // keeps upstream's api.onQueryParams from claiming our callback

function getClientId() {
    return (lsGet(KEYS.clientId, '') || '').trim();
}

function setClientId(id) {
    lsSet(KEYS.clientId, (id || '').trim() || null);
    xf.dispatch('media:auth', status());
}

function getRedirectUri() {
    return redirectUriFor(window.location);
}

function getToken() {
    return lsGetJSON(KEYS.token, null);
}

function setToken(token) {
    lsSetJSON(KEYS.token, token);
}

function isConfigured() {
    return getClientId().length > 0;
}

function isLoggedIn() {
    const t = getToken();
    return !!(t && (t.refreshToken || !isExpired(t)));
}

function status() {
    return {
        configured: isConfigured(),
        loggedIn:   isLoggedIn(),
        error:      lsGet(KEYS.authError, null),
        redirectUri: getRedirectUri(),
    };
}

function setAuthError(msg) {
    lsSet(KEYS.authError, msg || null);
}

async function login({showDialog = false} = {}) {
    const clientId = getClientId();
    if(!clientId) throw new Error('Add your Spotify Client ID in Settings first.');
    const verifier    = generateVerifier(64);
    const state       = STATE_PREFIX + randomString(16);
    const redirectUri = getRedirectUri();
    const challenge   = await codeChallenge(verifier);
    // localStorage (not sessionStorage) so the verifier survives the iPad
    // standalone-PWA -> Safari sheet -> PWA round trip.
    lsSetJSON(KEYS.pkce, {verifier, state, redirectUri, createdAt: Date.now()});
    setAuthError(null);
    window.location.assign(buildAuthorizeUrl({clientId, redirectUri, challenge, state, showDialog}));
}

async function postToken(body) {
    const res = await fetch(SPOTIFY_TOKEN_URL, {
        method:  'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body,
    });
    let json = {};
    try { json = await res.json(); } catch(e) { /* empty */ }
    if(!res.ok) {
        const err = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
        err.status = res.status;
        err.fatal  = isFatalRefreshError(res.status, json);
        throw err;
    }
    return json;
}

// Handles ?code=...&state=spotify_... ; accepts a pasted URL too (fallback when the
// redirect landed in Safari instead of the home-screen app).
async function handleCallback(urlOrSearch = window.location.search) {
    const cb = parseCallback(urlOrSearch);
    if(!cb) return false;
    if(cb.state && !cb.state.startsWith(STATE_PREFIX)) return false; // someone else's OAuth

    const pending = lsGetJSON(KEYS.pkce, null);
    if(cb.error) {
        setAuthError(cb.error === 'access_denied' ? 'Spotify login was cancelled.' : `Spotify error: ${cb.error}`);
        lsSet(KEYS.pkce, null);
        cleanUrl();
        xf.dispatch('media:auth', status());
        return true;
    }
    if(!pending || pending.state !== cb.state) {
        setAuthError('Spotify login state mismatch (start the login again from this app).');
        cleanUrl();
        xf.dispatch('media:auth', status());
        return true;
    }
    try {
        const json = await postToken(tokenRequestBody({
            clientId: getClientId(),
            code: cb.code,
            redirectUri: pending.redirectUri,
            verifier: pending.verifier,
        }));
        setToken(normalizeTokenResponse(json, Date.now()));
        setAuthError(null);
        scheduler.schedule();
    } catch(err) {
        setAuthError(`Spotify login failed: ${err.message}`);
    } finally {
        lsSet(KEYS.pkce, null);
        cleanUrl();
        xf.dispatch('media:auth', status());
    }
    return true;
}

function cleanUrl() {
    try {
        const url = new URL(window.location.href);
        if(url.searchParams.has('code') || url.searchParams.has('error')) {
            ['code', 'state', 'error'].forEach(k => url.searchParams.delete(k));
            window.history.replaceState({}, document.title, url.pathname + (url.search || '') + url.hash);
        }
    } catch(e) { /* ignore */ }
}

const refresh = singleFlight(async function() {
    const token = getToken();
    if(!token || !token.refreshToken) {
        const err = new Error('Not logged in to Spotify'); err.fatal = true; throw err;
    }
    try {
        const json = await postToken(refreshRequestBody({clientId: getClientId(), refreshToken: token.refreshToken}));
        const next = normalizeTokenResponse(json, Date.now(), token);
        setToken(next);
        return next;
    } catch(err) {
        if(err.fatal) logout('Spotify session expired, please connect again.');
        throw err;
    }
});

const scheduler = createRefreshScheduler({
    getToken,
    refresh,
    onFatal: () => xf.dispatch('media:auth', status()),
});

// -> Promise<String> a valid access token (refreshing when needed)
async function getAccessToken({force = false} = {}) {
    const token = getToken();
    if(!token) throw Object.assign(new Error('Not connected to Spotify'), {code: 'NOT_LOGGED_IN'});
    if(force || isExpired(token)) {
        const next = await refresh();
        scheduler.schedule();
        return next.accessToken;
    }
    return token.accessToken;
}

function logout(reason = null) {
    scheduler.cancel();
    setToken(null);
    lsSet(KEYS.pkce, null);
    setAuthError(reason);
    xf.dispatch('media:auth', status());
}

function start() {
    if(isLoggedIn()) scheduler.schedule();
    // iPad suspends timers in background tabs: re-check on wake
    document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible' && isLoggedIn()) {
            const t = getToken();
            if(isExpired(t)) refresh().then(() => scheduler.schedule()).catch(() => {});
            else scheduler.schedule();
        }
    });
}

export {
    getClientId,
    setClientId,
    getRedirectUri,
    isConfigured,
    isLoggedIn,
    status,
    login,
    logout,
    handleCallback,
    getAccessToken,
    start,
};
