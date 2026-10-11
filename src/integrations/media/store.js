//
// Persistence for the media integration.
//   localStorage 'media:*'  -> client id, tokens, preferences (small, sync)
//   IndexedDB 'flux-media'  -> resume positions + saved RSS feeds (own DB, does not touch src/db.js)
//

const KEYS = {
    clientId:   'media:spotify-client-id',
    token:      'media:spotify-token',
    pkce:       'media:spotify-pkce',      // {verifier, state, redirectUri} during login
    authError:  'media:spotify-auth-error',
    prefs:      'media:prefs',
    intensity:  'media:intensity',
    corsProxy:  'media:cors-proxy',
};

function lsGet(key, fallback = null) {
    try {
        const raw = globalThis.localStorage?.getItem(key);
        if(raw === null || raw === undefined) return fallback;
        return raw;
    } catch(e) { return fallback; }
}

function lsSet(key, value) {
    try {
        if(value === null || value === undefined) {
            globalThis.localStorage?.removeItem(key);
        } else {
            globalThis.localStorage?.setItem(key, value);
        }
    } catch(e) { console.warn(':media :storage', e); }
}

function lsGetJSON(key, fallback = null) {
    const raw = lsGet(key);
    if(raw === null) return fallback;
    try { return JSON.parse(raw); } catch(e) { return fallback; }
}

function lsSetJSON(key, value) {
    lsSet(key, value === null || value === undefined ? null : JSON.stringify(value));
}

const DEFAULT_PREFS = {
    autoPauseSpoken: true,   // pause podcasts/audiobooks when the workout is paused
    autoResume:      true,   // resume what we paused when the workout resumes
    useWebPlayer:    true,   // desktop browsers: register this tab as a Spotify Connect device
};

function getPrefs() {
    return Object.assign({}, DEFAULT_PREFS, lsGetJSON(KEYS.prefs, {}));
}

function setPrefs(patch = {}) {
    const prefs = Object.assign(getPrefs(), patch);
    lsSetJSON(KEYS.prefs, prefs);
    return prefs;
}

//
// IndexedDB (tiny promise wrapper)
//
const DB_NAME    = 'flux-media';
const DB_VERSION = 1;
let dbPromise    = null;

function openDB() {
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if(!globalThis.indexedDB) return reject(new Error('IndexedDB unavailable'));
        const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if(!db.objectStoreNames.contains('positions')) db.createObjectStore('positions', {keyPath: 'id'});
            if(!db.objectStoreNames.contains('feeds'))     db.createObjectStore('feeds',     {keyPath: 'url'});
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    }).catch(err => { dbPromise = null; throw err; });
    return dbPromise;
}

async function tx(store, mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const t   = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror    = () => reject(t.error);
        t.onabort    = () => reject(t.error);
    });
}

// Positions: {id, title, position (s), duration (s), updatedAt}
async function getPosition(id) {
    try { return await tx('positions', 'readonly', s => s.get(id)) || null; }
    catch(e) { return lsGetJSON(`media:pos:${id}`, null); }
}

async function savePosition(record) {
    const value = Object.assign({}, record, {updatedAt: Date.now()});
    try { await tx('positions', 'readwrite', s => s.put(value)); }
    catch(e) { lsSetJSON(`media:pos:${record.id}`, value); }
    return value;
}

async function listPositions() {
    try { return await tx('positions', 'readonly', s => s.getAll()) || []; }
    catch(e) { return []; }
}

async function listFeeds() {
    try { return await tx('feeds', 'readonly', s => s.getAll()) || []; }
    catch(e) { return lsGetJSON('media:feeds', []); }
}

async function saveFeed(feed) {
    const value = {url: feed.url, title: feed.title || feed.url, image: feed.image || '', addedAt: Date.now()};
    try { await tx('feeds', 'readwrite', s => s.put(value)); }
    catch(e) {
        const feeds = lsGetJSON('media:feeds', []).filter(f => f.url !== value.url);
        feeds.push(value);
        lsSetJSON('media:feeds', feeds);
    }
    return value;
}

async function removeFeed(url) {
    try { await tx('feeds', 'readwrite', s => s.delete(url)); }
    catch(e) { lsSetJSON('media:feeds', lsGetJSON('media:feeds', []).filter(f => f.url !== url)); }
}

export {
    KEYS,
    lsGet,
    lsSet,
    lsGetJSON,
    lsSetJSON,
    DEFAULT_PREFS,
    getPrefs,
    setPrefs,
    getPosition,
    savePosition,
    listPositions,
    listFeeds,
    saveFeed,
    removeFeed,
};
