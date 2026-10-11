//
// Google Calendar client: Google Identity Services (GIS) token client + REST.
//
// Purely client-side OAuth 2.0 implicit-style token flow. The user brings their
// own OAuth Client ID (localStorage['calendar:google-client-id']). Access tokens
// are short lived (~1h) and kept in localStorage['calendar:google-token'].
//

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/calendar/v3';

const SCOPES = {
    events:     'https://www.googleapis.com/auth/calendar.events',
    freebusy:   'https://www.googleapis.com/auth/calendar.freebusy',
    // only needed for the optional dedicated "Training" calendar
    appCreated: 'https://www.googleapis.com/auth/calendar.app.created',
};

const KEYS = {
    clientId:   'calendar:google-client-id',
    token:      'calendar:google-token',
    trainingId: 'calendar:google-training-calendar-id',
};

function ls() {
    try { return globalThis.localStorage; } catch (_) { return undefined; }
}
function getItem(k) { return ls()?.getItem(k) ?? null; }
function setItem(k, v) { try { ls()?.setItem(k, v); } catch (_) {} }
function removeItem(k) { try { ls()?.removeItem(k); } catch (_) {} }

function getClientId() { return (getItem(KEYS.clientId) ?? '').trim(); }
function setClientId(id) { setItem(KEYS.clientId, (id ?? '').trim()); removeItem(KEYS.token); }
function isConfigured() { return /\.apps\.googleusercontent\.com$/.test(getClientId()); }

function scopesFor({trainingCalendar = false} = {}) {
    const s = [SCOPES.events, SCOPES.freebusy];
    if(trainingCalendar) s.push(SCOPES.appCreated);
    return s.join(' ');
}

// --- GIS loading -----------------------------------------------------------

let gisPromise;
function loadGis() {
    if(globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google);
    if(gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = GIS_SRC;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve(globalThis.google);
        script.onerror = () => { gisPromise = undefined; reject(new Error('Could not load Google Identity Services')); };
        document.head.appendChild(script);
    });
    return gisPromise;
}

// --- tokens ------------------------------------------------------------------

function storedToken() {
    try {
        const t = JSON.parse(getItem(KEYS.token) ?? 'null');
        if(t && t.access_token && t.expires_at > Date.now() + 60000) return t;
    } catch (_) {}
    return null;
}

function isConnected() { return !!storedToken(); }

function disconnect() {
    const t = storedToken();
    removeItem(KEYS.token);
    if(t && globalThis.google?.accounts?.oauth2?.revoke) {
        globalThis.google.accounts.oauth2.revoke(t.access_token, () => {});
    }
}

// Must be called from a user gesture (button tap) the first time, since GIS opens a popup.
// Call loadGis() ahead of time (e.g. when settings open) so the popup is not blocked on iPad.
async function requestToken({trainingCalendar = false, prompt = ''} = {}) {
    const clientId = getClientId();
    if(!isConfigured()) throw new Error('Google OAuth Client ID is not set');
    const google = await loadGis();
    const scope = scopesFor({trainingCalendar});

    return new Promise((resolve, reject) => {
        const callback = (resp) => {
            if(resp.error) return reject(new Error(resp.error_description || resp.error));
            const token = {
                access_token: resp.access_token,
                scope: resp.scope,
                expires_at: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
            };
            setItem(KEYS.token, JSON.stringify(token));
            resolve(token);
        };
        // re-created per request so callbacks always resolve this promise
        const tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope,
            callback,
            error_callback: (err) => reject(new Error(err?.message || err?.type || 'OAuth error')),
        });
        tokenClient.requestAccessToken({prompt});
    });
}

async function getToken(opts = {}) {
    return storedToken() ?? requestToken(opts);
}

// --- REST --------------------------------------------------------------------

class GoogleApiError extends Error {
    constructor(status, body) {
        super(`Google Calendar API ${status}: ${body?.error?.message ?? ''}`);
        this.status = status;
        this.body = body;
    }
}

function GoogleCalendarClient({fetch: f = (...a) => globalThis.fetch(...a), tokenOpts = {}} = {}) {

    async function call(method, path, {query, body} = {}, retry = true) {
        const token = await getToken(tokenOpts);
        const url = new URL(API + path);
        for(const [k, v] of Object.entries(query ?? {})) {
            if(v !== undefined && v !== null) url.searchParams.append(k, v);
        }
        const res = await f(url.toString(), {
            method,
            headers: Object.assign(
                {'Authorization': `Bearer ${token.access_token}`},
                body ? {'Content-Type': 'application/json'} : {}),
            body: body ? JSON.stringify(body) : undefined,
        });
        if(res.status === 401 && retry) {
            removeItem(KEYS.token);
            return call(method, path, {query, body}, false);
        }
        if(res.status === 204) return null;
        const json = await res.json().catch(() => null);
        if(!res.ok) throw new GoogleApiError(res.status, json);
        return json;
    }

    const cal = (id) => `/calendars/${encodeURIComponent(id)}`;

    async function freeBusy({timeMin, timeMax, calendarIds = ['primary']}) {
        const json = await call('POST', '/freeBusy', {body: {
            timeMin: new Date(timeMin).toISOString(),
            timeMax: new Date(timeMax).toISOString(),
            items: calendarIds.map(id => ({id})),
        }});
        return Object.values(json?.calendars ?? {}).flatMap(c => c.busy ?? []);
    }

    async function listEvents(calendarId, {timeMin, timeMax, privateExtendedProperty} = {}) {
        const out = [];
        let pageToken;
        do {
            const json = await call('GET', `${cal(calendarId)}/events`, {query: {
                timeMin: timeMin ? new Date(timeMin).toISOString() : undefined,
                timeMax: timeMax ? new Date(timeMax).toISOString() : undefined,
                privateExtendedProperty,
                singleEvents: 'true',
                maxResults: '250',
                pageToken,
            }});
            out.push(...(json?.items ?? []));
            pageToken = json?.nextPageToken;
        } while(pageToken);
        return out;
    }

    async function getEvent(calendarId, eventId) {
        try {
            return await call('GET', `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
        } catch (err) {
            if(err.status === 404 || err.status === 410) return null;
            throw err;
        }
    }

    function insertEvent(calendarId, body) {
        return call('POST', `${cal(calendarId)}/events`, {body});
    }

    function patchEvent(calendarId, eventId, body) {
        return call('PATCH', `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, {body});
    }

    async function deleteEvent(calendarId, eventId) {
        try {
            await call('DELETE', `${cal(calendarId)}/events/${encodeURIComponent(eventId)}`);
        } catch (err) {
            if(err.status === 404 || err.status === 410) return;
            throw err;
        }
    }

    // Dedicated secondary calendar (requires calendar.app.created scope)
    async function ensureCalendar(summary = 'Training') {
        const known = getItem(KEYS.trainingId);
        if(known) {
            try {
                await call('GET', cal(known));
                return known;
            } catch (err) {
                if(err.status !== 404 && err.status !== 403) throw err;
            }
        }
        const created = await call('POST', '/calendars', {body: {
            summary,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }});
        setItem(KEYS.trainingId, created.id);
        return created.id;
    }

    return Object.freeze({
        freeBusy, listEvents, getEvent, insertEvent, patchEvent, deleteEvent, ensureCalendar,
    });
}

export {
    SCOPES, KEYS,
    getClientId, setClientId, isConfigured, isConnected, disconnect,
    loadGis, requestToken, getToken, scopesFor,
    GoogleCalendarClient, GoogleApiError,
};
