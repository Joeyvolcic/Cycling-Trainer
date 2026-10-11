// Claude client for in-browser use with the rider's own Anthropic API key.
//
// Contract (doc/integrations-contract.md):
//   isConfigured() -> Boolean
//   async complete({system, prompt, json=false, maxTokens}) -> String | Object
//
// Extra (optional) params on complete():
//   schema  - JSON schema; with json=true the response is constrained via
//             structured outputs (output_config.format) and parsed.
//   effort  - 'low' | 'medium' | 'high' (default 'low'); Opus 5.5 always thinks,
//             effort is the only depth/cost control so we always send it.
//   model   - override the model chosen in settings.
//
// The key lives only in this device's localStorage['ai:anthropic-key'] and is
// sent directly from the browser to api.anthropic.com.
import * as sdk from '@anthropic-ai/sdk';

const KEY_STORAGE   = 'ai:anthropic-key';
const MODEL_STORAGE = 'ai:model';

const DEFAULT_MODEL = 'claude-opus-5-5';

const MODELS = [
    {id: 'claude-opus-5-5',   name: 'Claude Opus 5.5 (best)'},
    {id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (cheaper)'},
    {id: 'claude-haiku-5-5',  name: 'Claude Haiku 5.5 (cheapest)'},
];

// Server-side refusal fallback ("default" routing). Supported on the Claude API
// for Opus 5.5 and Sonnet 5.5; Haiku 5.5 has no server-side fallback.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

function storage() {
    try { return globalThis.localStorage; } catch(e) { return undefined; }
}

function getKey() {
    return (storage()?.getItem(KEY_STORAGE) ?? '').trim();
}

function setKey(key = '') {
    const value = String(key).trim();
    if(value === '') return clearKey();
    storage()?.setItem(KEY_STORAGE, value);
    resetClient();
}

function clearKey() {
    storage()?.removeItem(KEY_STORAGE);
    resetClient();
}

function getModel() {
    const model = storage()?.getItem(MODEL_STORAGE);
    return MODELS.some((m) => m.id === model) ? model : DEFAULT_MODEL;
}

function setModel(model) {
    if(MODELS.some((m) => m.id === model)) {
        storage()?.setItem(MODEL_STORAGE, model);
    }
}

function isConfigured() {
    return getKey().length > 0;
}

// Typed error so UI can show a sensible message without string matching
class AiError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.name = 'AiError';
        this.code = code;
        this.cause = cause;
    }
}

let client;
let clientKey;

function resetClient() {
    client = undefined;
    clientKey = undefined;
}

async function getClient() {
    const key = getKey();
    if(!key) {
        throw new AiError('no-key', 'Add your Anthropic API key in Settings → AI Coach.');
    }
    const Anthropic = sdk.default;
    if(!client || clientKey !== key) {
        client = new Anthropic({
            apiKey: key,
            dangerouslyAllowBrowser: true,
            maxRetries: 2,
            timeout: 120 * 1000,
        });
        clientKey = key;
    }
    return client;
}

function toAiError(error, mod) {
    if(error instanceof AiError) return error;
    const pick = (name) => mod?.[name] ?? mod?.default?.[name];
    const is = (name) => { const cls = pick(name); return !!cls && error instanceof cls; };

    if(is('AuthenticationError')) {
        return new AiError('auth', 'Anthropic rejected the API key. Check it in Settings → AI Coach.', error);
    }
    if(is('PermissionDeniedError')) {
        return new AiError('permission', 'This API key is not allowed to use the selected model.', error);
    }
    if(is('NotFoundError')) {
        return new AiError('not-found', 'The selected model was not found. Try another model in Settings.', error);
    }
    if(is('RateLimitError')) {
        return new AiError('rate-limit', 'Rate limited by Anthropic. Wait a minute and try again.', error);
    }
    if(is('BadRequestError')) {
        return new AiError('bad-request', `Request rejected: ${error.message}`, error);
    }
    if(is('InternalServerError')) {
        return new AiError('server', 'Anthropic is temporarily unavailable or overloaded. Try again shortly.', error);
    }
    if(is('APIConnectionTimeoutError')) {
        return new AiError('timeout', 'The request to Anthropic timed out.', error);
    }
    if(is('APIConnectionError')) {
        return new AiError('connection', 'Could not reach Anthropic. Check your internet connection.', error);
    }
    if(is('APIError')) {
        return new AiError('api', `Anthropic API error ${error.status ?? ''}: ${error.message}`, error);
    }
    return new AiError('unknown', error?.message ?? String(error), error);
}

function extractText(message) {
    return (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
}

function parseJson(text) {
    const trimmed = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
    try {
        return JSON.parse(trimmed);
    } catch(e) {
        // tolerate leading/trailing prose when no schema was used
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if(start >= 0 && end > start) {
            try { return JSON.parse(trimmed.slice(start, end + 1)); } catch(_) {}
        }
        throw new AiError('parse', 'Claude returned a response that was not valid JSON.', e);
    }
}

// Build request params (exported for tests)
function buildParams({system, prompt, json = false, schema, maxTokens, effort = 'low', model} = {}) {
    const m = model ?? getModel();
    const output_config = { effort };

    let sys = system;
    if(json && schema) {
        output_config.format = { type: 'json_schema', schema };
    } else if(json) {
        sys = [system, 'Respond with a single JSON object only, no prose and no code fences.']
            .filter(Boolean).join('\n\n');
    }

    const params = {
        model: m,
        max_tokens: maxTokens ?? 16000,
        output_config,
        messages: [{ role: 'user', content: prompt }],
    };
    if(sys) params.system = sys;

    const useFallback = FALLBACK_MODELS.has(m);
    if(useFallback) {
        params.betas = [FALLBACK_BETA];
        params.fallbacks = 'default';
    }

    return { params, useFallback };
}

async function complete(args = {}) {
    const { params, useFallback } = buildParams(args);
    const c = await getClient();
    const mod = sdk;

    let message;
    try {
        message = useFallback ?
            await c.beta.messages.create(params) :
            await c.messages.create(params);
    } catch(error) {
        throw toAiError(error, mod);
    }

    if(message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new AiError(
            'refusal',
            `Claude declined this request${category ? ` (${category})` : ''}.`,
        );
    }
    if(message.stop_reason === 'max_tokens') {
        throw new AiError('truncated', 'Claude ran out of output tokens before finishing.');
    }

    const text = extractText(message);
    return args.json ? parseJson(text) : text;
}

export {
    isConfigured,
    complete,

    getKey,
    setKey,
    clearKey,
    getModel,
    setModel,
    buildParams,
    AiError,
    MODELS,
    DEFAULT_MODEL,
    KEY_STORAGE,
    MODEL_STORAGE,
};
