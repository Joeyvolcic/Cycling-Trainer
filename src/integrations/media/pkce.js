//
// OAuth 2.0 Authorization Code + PKCE helpers (RFC 7636), pure / injectable.
//

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL     = 'https://accounts.spotify.com/api/token';

const SPOTIFY_SCOPES = [
    'user-read-private',            // product (premium/free) + country for market
    'user-read-email',              // required by the Web Playback SDK
    'streaming',                    // Web Playback SDK (desktop browsers)
    'user-read-playback-state',     // devices, now playing
    'user-modify-playback-state',   // play/pause/skip/seek/volume/transfer
    'user-read-currently-playing',
    'user-read-playback-position',  // podcast/audiobook resume points
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read',            // saved shows, episodes, audiobooks
];

function defaultCrypto() {
    return globalThis.crypto;
}

// Int -> String, random string over the unreserved charset (43..128 chars for a verifier)
function randomString(length = 64, crypto = defaultCrypto()) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for(let i = 0; i < length; i++) {
        // 256 % 66 != 0 so there is a tiny bias; irrelevant for 64 chars of entropy
        out += UNRESERVED[bytes[i] % UNRESERVED.length];
    }
    return out;
}

function generateVerifier(length = 64, crypto = defaultCrypto()) {
    if(length < 43 || length > 128) {
        throw new Error('PKCE verifier length must be between 43 and 128');
    }
    return randomString(length, crypto);
}

// ArrayBuffer | Uint8Array -> String (base64url, no padding)
function base64url(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    for(let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary); // available in browsers and Node >= 16
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// String -> Promise<String>, S256 code challenge
async function codeChallenge(verifier, crypto = defaultCrypto()) {
    const data   = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64url(digest);
}

function buildAuthorizeUrl({clientId, redirectUri, challenge, state, scopes = SPOTIFY_SCOPES, showDialog = false}) {
    if(!clientId)    throw new Error('Missing Spotify Client ID');
    if(!redirectUri) throw new Error('Missing redirect URI');
    const params = new URLSearchParams({
        client_id:             clientId,
        response_type:         'code',
        redirect_uri:          redirectUri,
        code_challenge_method: 'S256',
        code_challenge:        challenge,
        state:                 state,
        scope:                 scopes.join(' '),
    });
    if(showDialog) params.set('show_dialog', 'true');
    return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

function tokenRequestBody({clientId, code, redirectUri, verifier}) {
    return new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        code_verifier: verifier,
    }).toString();
}

function refreshRequestBody({clientId, refreshToken}) {
    return new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
        client_id:     clientId,
    }).toString();
}

// String (search or full url) -> {code, state, error} | null
function parseCallback(input = '') {
    let search = input;
    const q = input.indexOf('?');
    if(q >= 0) search = input.slice(q + 1);
    search = search.split('#')[0];
    const params = new URLSearchParams(search);
    const code  = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    if(!code && !error) return null;
    return {code, state, error};
}

// The redirect URI is "where the app is served", without query/hash.
// Spotify requires an exact match with what is registered in the dashboard.
function redirectUriFor(location) {
    return `${location.origin}${location.pathname}`;
}

export {
    SPOTIFY_AUTHORIZE_URL,
    SPOTIFY_TOKEN_URL,
    SPOTIFY_SCOPES,
    randomString,
    generateVerifier,
    base64url,
    codeChallenge,
    buildAuthorizeUrl,
    tokenRequestBody,
    refreshRequestBody,
    parseCallback,
    redirectUriFor,
};
