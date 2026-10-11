//
// Analysis / export preferences and credentials.
// Everything lives in localStorage under `analysis:*` (see doc/integrations-contract.md).
//

const PREFIX = 'analysis:';

const Keys = {
    targets:            'upload-targets',      // JSON {strava: Bool, intervals: Bool, trainingPeaks: Bool}
    autoUpload:         'auto-upload',         // 'true' | 'false'
    intervalsAthleteId: 'intervals-athlete-id',
    intervalsApiKey:    'intervals-api-key',
    stravaClientId:     'strava-client-id',
    stravaClientSecret: 'strava-client-secret',
    stravaRefreshToken: 'strava-refresh-token',
    stravaAccessToken:  'strava-access-token',
    stravaExpiresAt:    'strava-expires-at',   // epoch seconds
    stravaScope:        'strava-scope',
    stravaHide:         'strava-hide-from-home', // 'true' (default) | 'false'
    maxHr:              'max-hr',
    lthr:               'lthr',
    workoutSession:     'workout-session',     // JSON {startedAt}
};

function storage() {
    try {
        return globalThis.localStorage ?? null;
    } catch(e) {
        return null;
    }
}

function get(key, fallback = '') {
    const s = storage();
    if(!s) return fallback;
    const v = s.getItem(PREFIX + key);
    return v === null ? fallback : v;
}

function set(key, value) {
    const s = storage();
    if(!s) return;
    if(value === undefined || value === null || value === '') {
        s.removeItem(PREFIX + key);
    } else {
        s.setItem(PREFIX + key, String(value));
    }
}

function getJSON(key, fallback) {
    try {
        const v = get(key, '');
        return v === '' ? fallback : JSON.parse(v);
    } catch(e) {
        return fallback;
    }
}

function setJSON(key, value) {
    set(key, JSON.stringify(value));
}

function getBool(key, fallback = false) {
    const v = get(key, '');
    if(v === '') return fallback;
    return v === 'true';
}

function getInt(key) {
    const v = parseInt(get(key, ''));
    return Number.isFinite(v) && v > 0 ? v : null;
}

const defaultTargets = {strava: false, intervals: false, trainingPeaks: false};

function getTargets() {
    return Object.assign({}, defaultTargets, getJSON(Keys.targets, {}));
}

function setTarget(service, enabled) {
    const targets = getTargets();
    targets[service] = !!enabled;
    setJSON(Keys.targets, targets);
    return targets;
}

function intervalsDirect() {
    const athleteId = get(Keys.intervalsAthleteId).trim();
    const apiKey = get(Keys.intervalsApiKey).trim();
    return {
        athleteId: athleteId === '' ? '0' : athleteId, // '0' = athlete owning the key
        apiKey,
        configured: apiKey !== '',
    };
}

function stravaDirect() {
    const clientId = get(Keys.stravaClientId).trim();
    const clientSecret = get(Keys.stravaClientSecret).trim();
    const refreshToken = get(Keys.stravaRefreshToken).trim();
    return {
        clientId,
        clientSecret,
        refreshToken,
        accessToken: get(Keys.stravaAccessToken),
        expiresAt: parseInt(get(Keys.stravaExpiresAt, '0')) || 0,
        scope: get(Keys.stravaScope),
        hideFromHome: getBool(Keys.stravaHide, true),
        hasApp: clientId !== '' && clientSecret !== '',
        configured: clientId !== '' && clientSecret !== '' && refreshToken !== '',
    };
}

function athlete() {
    return {
        maxHr: getInt(Keys.maxHr),
        lthr: getInt(Keys.lthr),
    };
}

export {
    Keys,
    get,
    set,
    getJSON,
    setJSON,
    getBool,
    getTargets,
    setTarget,
    intervalsDirect,
    stravaDirect,
    athlete,
};
