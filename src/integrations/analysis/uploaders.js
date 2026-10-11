//
// Upload adapters. Each user-facing service ('strava', 'intervals', 'trainingPeaks')
// resolves to one concrete route:
//
//   strava        -> 'strava-direct'    (user's own Strava API app, tokens in localStorage)
//                 -> 'auuki'            (upstream backend api.auuki.com, cookie session)
//   intervals     -> 'intervals-direct' (athlete id + personal API key, basic auth)
//                 -> 'auuki'
//   trainingPeaks -> 'auuki'            (no public API for individuals)
//
// upload(job, {progress}) resolves to {remote} or throws UploadError.
//

import * as settings from './settings.js';

const STRAVA_API = 'https://www.strava.com/api/v3';
const STRAVA_TOKEN = 'https://www.strava.com/oauth/token';
const INTERVALS_API = 'https://intervals.icu/api/v1';
const DEFAULT_AUUKI_API = 'https://api.auuki.com';

class UploadError extends Error {
    constructor(message, {retryable = true, needsSetup = false, status} = {}) {
        super(message);
        this.name = 'UploadError';
        this.retryable = retryable;
        this.needsSetup = needsSetup;
        this.status = status;
    }
}

function errorFromStatus(status, text = '') {
    if(status === 401 || status === 403) {
        return new UploadError(`Not authorized (${status}). Check the service setup.`, {
            retryable: false, needsSetup: true, status,
        });
    }
    if(status === 408 || status === 429 || status >= 500) {
        return new UploadError(`Service unavailable (${status}). Will retry.`, {retryable: true, status});
    }
    return new UploadError(`Upload rejected (${status}) ${text}`.trim(), {retryable: false, status});
}

async function safeFetch(fetchFn, url, init) {
    try {
        return await fetchFn(url, init);
    } catch(e) {
        // offline, DNS, CORS failures: always retry later
        throw new UploadError(`Network error: ${e.message ?? e}`, {retryable: true});
    }
}

function fileName(job) {
    return `auuki-${job.activityId}.fit`;
}

function externalId(job) {
    return `auuki-${job.activityId}`;
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// --- intervals.icu (API key) -------------------------------------------------

function IntervalsDirect(deps = {}) {
    const fetchFn = deps.fetch ?? ((...a) => globalThis.fetch(...a));

    function available() {
        return settings.intervalsDirect().configured;
    }

    async function upload(job) {
        const {athleteId, apiKey, configured} = settings.intervalsDirect();
        if(!configured) throw new UploadError('intervals.icu API key not set', {retryable: false, needsSetup: true});

        const params = new URLSearchParams({name: job.name ?? 'Auuki ride', external_id: externalId(job)});
        const url = `${INTERVALS_API}/athlete/${encodeURIComponent(athleteId)}/activities?${params}`;
        const form = new FormData();
        form.append('file', job.blob, fileName(job));

        const res = await safeFetch(fetchFn, url, {
            method: 'POST',
            headers: {Authorization: 'Basic ' + btoa(`API_KEY:${apiKey}`)},
            body: form,
        });
        if(!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));

        // 201 created, 200 = duplicate (de-duplicated by file hash) - both fine
        let body = [];
        try { body = await res.json(); } catch(e) { /* empty body */ }
        const id = Array.isArray(body) ? body[0]?.id : body?.id;
        return {remote: {activityId: id ?? null, url: id ? `https://intervals.icu/activities/${id}` : null}};
    }

    return {route: 'intervals-direct', available, upload};
}

// --- Strava (user's own API application) -------------------------------------

function StravaDirect(deps = {}) {
    const fetchFn = deps.fetch ?? ((...a) => globalThis.fetch(...a));
    const pollInterval = deps.pollInterval ?? 2000;
    const pollAttempts = deps.pollAttempts ?? 30;

    function available() {
        return settings.stravaDirect().configured;
    }

    function saveToken(body) {
        settings.set(settings.Keys.stravaAccessToken, body.access_token);
        settings.set(settings.Keys.stravaExpiresAt, body.expires_at);
        if(body.refresh_token) settings.set(settings.Keys.stravaRefreshToken, body.refresh_token);
    }

    async function exchangeCode(code, scope = '') {
        const s = settings.stravaDirect();
        const body = new URLSearchParams({
            client_id: s.clientId,
            client_secret: s.clientSecret,
            code,
            grant_type: 'authorization_code',
        });
        const res = await safeFetch(fetchFn, STRAVA_TOKEN, {method: 'POST', body});
        if(!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
        const json = await res.json();
        saveToken(json);
        settings.set(settings.Keys.stravaScope, scope);
        return json;
    }

    async function token() {
        const s = settings.stravaDirect();
        if(!s.configured) throw new UploadError('Strava app not connected', {retryable: false, needsSetup: true});
        const now = Math.floor(Date.now() / 1000);
        if(s.accessToken && s.expiresAt - 60 > now) return s.accessToken;

        const body = new URLSearchParams({
            client_id: s.clientId,
            client_secret: s.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: s.refreshToken,
        });
        const res = await safeFetch(fetchFn, STRAVA_TOKEN, {method: 'POST', body});
        if(!res.ok) {
            if(res.status === 400 || res.status === 401) {
                throw new UploadError('Strava authorization expired. Reconnect in Settings.', {retryable: false, needsSetup: true, status: res.status});
            }
            throw errorFromStatus(res.status);
        }
        const json = await res.json();
        saveToken(json);
        return json.access_token;
    }

    function duplicateActivityId(error = '') {
        const m = String(error).match(/activities\/(\d+)/);
        return m ? m[1] : null;
    }

    async function poll(uploadId, auth) {
        for(let i = 0; i < pollAttempts; i++) {
            const res = await safeFetch(fetchFn, `${STRAVA_API}/uploads/${uploadId}`, {
                headers: {Authorization: `Bearer ${auth}`},
            });
            if(!res.ok) throw errorFromStatus(res.status);
            const body = await res.json();
            if(body.activity_id) return {activityId: String(body.activity_id), duplicate: false};
            if(body.error) {
                const dup = duplicateActivityId(body.error);
                if(/duplicate/i.test(body.error)) return {activityId: dup, duplicate: true};
                throw new UploadError(`Strava could not process the file: ${body.error}`, {retryable: false});
            }
            await sleep(pollInterval);
        }
        throw new UploadError('Strava is still processing the upload. Will check again.', {retryable: true});
    }

    async function upload(job, {progress = () => {}} = {}) {
        const s = settings.stravaDirect();
        const auth = await token();
        let uploadId = job.remote?.uploadId;

        if(!uploadId) {
            const form = new FormData();
            form.append('file', job.blob, fileName(job));
            form.append('name', job.name ?? 'Auuki ride');
            form.append('description', 'Indoor ride recorded with Auuki');
            form.append('trainer', '1');
            form.append('data_type', 'fit');
            form.append('external_id', fileName(job));

            const res = await safeFetch(fetchFn, `${STRAVA_API}/uploads`, {
                method: 'POST',
                headers: {Authorization: `Bearer ${auth}`},
                body: form,
            });
            if(!res.ok) throw errorFromStatus(res.status, await res.text().catch(() => ''));
            const body = await res.json();
            uploadId = body.id_str ?? String(body.id);
            await progress({uploadId});
        }

        const {activityId, duplicate} = await poll(uploadId, auth);
        const remote = {
            uploadId,
            activityId,
            duplicate,
            url: activityId ? `https://www.strava.com/activities/${activityId}` : null,
            hidden: false,
        };

        // Strava's API cannot make an activity private ("Only You"): visibility always
        // follows the athlete's default. The closest we can do is mute it from feeds.
        if(activityId && !duplicate && s.hideFromHome) {
            try {
                const res = await safeFetch(fetchFn, `${STRAVA_API}/activities/${activityId}`, {
                    method: 'PUT',
                    headers: {Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json'},
                    body: JSON.stringify({hide_from_home: true, trainer: true}),
                });
                remote.hidden = res.ok;
                if(!res.ok) remote.warning = `Could not mute activity (${res.status})`;
            } catch(e) {
                remote.warning = 'Could not mute activity (network)';
            }
        }
        return {remote};
    }

    function authorizeUrl(redirectUri, state) {
        const s = settings.stravaDirect();
        return 'https://www.strava.com/oauth/authorize?' + new URLSearchParams({
            client_id: s.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            approval_prompt: 'auto',
            // read_all is required to update activities that are already "Only You"
            scope: 'activity:write,activity:read_all',
            state,
        }).toString();
    }

    return {route: 'strava-direct', available, upload, exchangeCode, authorizeUrl, token};
}

// --- upstream backend (api.auuki.com) ----------------------------------------

function AuukiBackend(service, deps = {}) {
    const fetchFn = deps.fetch ?? ((...a) => globalThis.fetch(...a));
    const isConnected = deps.isConnected ?? (() => false);
    const apiUri = deps.apiUri ?? (() => DEFAULT_AUUKI_API);
    const path = {strava: 'strava', intervals: 'intervals', trainingPeaks: 'trainingpeaks'}[service];

    function available() {
        return isConnected(service);
    }

    async function upload(job) {
        const form = new FormData();
        form.append('name', job.name ?? 'Powered by Auuki workout');
        form.append('file', job.blob, fileName(job));
        const res = await safeFetch(fetchFn, `${apiUri()}/api/${path}/upload`, {
            method: 'POST',
            credentials: 'include',
            body: form,
        });
        if(!res.ok) throw errorFromStatus(res.status);
        return {remote: {}};
    }

    return {route: 'auuki', available, upload};
}

// Builds the resolver used by the queue
function Uploaders(deps = {}) {
    const stravaDirect = StravaDirect(deps);
    const intervalsDirect = IntervalsDirect(deps);
    const backend = {
        strava: AuukiBackend('strava', deps),
        intervals: AuukiBackend('intervals', deps),
        trainingPeaks: AuukiBackend('trainingPeaks', deps),
    };

    // -> adapter or null when the service isn't set up at all
    function resolve(service) {
        if(service === 'strava') {
            if(stravaDirect.available()) return stravaDirect;
            if(backend.strava.available()) return backend.strava;
            return null;
        }
        if(service === 'intervals') {
            if(intervalsDirect.available()) return intervalsDirect;
            if(backend.intervals.available()) return backend.intervals;
            return null;
        }
        if(service === 'trainingPeaks') {
            return backend.trainingPeaks.available() ? backend.trainingPeaks : null;
        }
        return null;
    }

    return {resolve, stravaDirect, intervalsDirect, backend};
}

const SERVICES = ['strava', 'intervals', 'trainingPeaks'];
const SERVICE_LABELS = {strava: 'Strava', intervals: 'intervals.icu', trainingPeaks: 'TrainingPeaks'};

export {
    UploadError,
    Uploaders,
    StravaDirect,
    IntervalsDirect,
    AuukiBackend,
    SERVICES,
    SERVICE_LABELS,
};
