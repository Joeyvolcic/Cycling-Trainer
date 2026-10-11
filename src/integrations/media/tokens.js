//
// Token bookkeeping and refresh scheduling (pure, timers injectable).
//

const DEFAULT_SKEW_MS = 60 * 1000;   // refresh one minute before expiry
const MIN_DELAY_MS    = 5 * 1000;
const MAX_BACKOFF_MS  = 5 * 60 * 1000;

// Spotify token endpoint response -> stored token
// PKCE refresh responses may or may not include a new refresh_token; keep the old one if not.
function normalizeTokenResponse(response = {}, now = Date.now(), previous = {}) {
    if(!response.access_token) throw new Error('Token response has no access_token');
    const expiresIn = Number(response.expires_in) || 3600;
    return {
        accessToken:  response.access_token,
        refreshToken: response.refresh_token || previous.refreshToken || null,
        scope:        response.scope || previous.scope || '',
        tokenType:    response.token_type || 'Bearer',
        expiresAt:    now + expiresIn * 1000,
    };
}

function isExpired(token, now = Date.now(), skewMs = DEFAULT_SKEW_MS) {
    if(!token || !token.accessToken) return true;
    return now >= (token.expiresAt - skewMs);
}

// ms until a refresh should happen; null when there is nothing to refresh with
function refreshDelay(token, now = Date.now(), {skewMs = DEFAULT_SKEW_MS, minMs = MIN_DELAY_MS} = {}) {
    if(!token || !token.refreshToken) return null;
    const delay = token.expiresAt - skewMs - now;
    return Math.max(minMs, delay);
}

// exponential backoff for failed (non-fatal) refreshes: 5s, 10s, 20s ... capped at 5 min
function retryDelay(attempt = 0, baseMs = MIN_DELAY_MS, maxMs = MAX_BACKOFF_MS) {
    return Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
}

// A refresh failure is fatal (user must log in again) when the grant was revoked / invalid.
function isFatalRefreshError(status, body = {}) {
    if(status === 400 || status === 401) {
        const err = (body && body.error) || '';
        return err === 'invalid_grant' || err === 'invalid_client' || err === 'unauthorized_client' || status === 401;
    }
    return false;
}

// Share a single in-flight promise between concurrent callers.
function singleFlight(fn) {
    let inflight = null;
    return function(...args) {
        if(inflight) return inflight;
        inflight = Promise.resolve()
            .then(() => fn(...args))
            .finally(() => { inflight = null; });
        return inflight;
    };
}

// Keeps a timer armed to refresh the token before it expires.
function createRefreshScheduler({
    getToken,
    refresh,                  // async () -> token ; throws {fatal: true} when the grant is gone
    onFatal = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    skewMs = DEFAULT_SKEW_MS,
} = {}) {
    let timer   = null;
    let attempt = 0;

    function cancel() {
        if(timer !== null) clearTimer(timer);
        timer = null;
    }

    function arm(ms) {
        cancel();
        timer = setTimer(run, ms);
        return ms;
    }

    async function run() {
        timer = null;
        try {
            await refresh();
            attempt = 0;
            schedule();
        } catch(err) {
            if(err && err.fatal) {
                cancel();
                onFatal(err);
                return;
            }
            arm(retryDelay(attempt++));
        }
    }

    // -> ms until next refresh, or null when nothing is scheduled
    function schedule() {
        const delay = refreshDelay(getToken(), now(), {skewMs});
        if(delay === null) {
            cancel();
            return null;
        }
        return arm(delay);
    }

    return Object.freeze({schedule, cancel, run, isArmed: () => timer !== null});
}

export {
    DEFAULT_SKEW_MS,
    normalizeTokenResponse,
    isExpired,
    refreshDelay,
    retryDelay,
    isFatalRefreshError,
    singleFlight,
    createRefreshScheduler,
};
