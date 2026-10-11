// STUB — real implementation comes from the AI branch
//
// Implements only the contract in doc/integrations-contract.md:
//   isConfigured() -> Boolean
//   async complete({system, prompt, json=false, maxTokens}) -> String | Object
// Uses the user's key from localStorage['ai:anthropic-key'].

const KEY = 'ai:anthropic-key';
const MODEL = 'claude-opus-5-5';

function apiKey() {
    try {
        return (globalThis.localStorage?.getItem(KEY) ?? '').trim();
    } catch(e) {
        return '';
    }
}

function isConfigured() {
    return apiKey() !== '';
}

function parseJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1] : text;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
}

async function complete({system, prompt, json = false, maxTokens = 4096} = {}) {
    if(!isConfigured()) throw new Error('Anthropic API key is not configured');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey(),
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
            model: MODEL,
            max_tokens: maxTokens,
            system: json ? `${system ?? ''}\nRespond with a single JSON object only.` : system,
            messages: [{role: 'user', content: prompt}],
        }),
    });

    if(!response.ok) {
        throw new Error(`Claude API error ${response.status}: ${await response.text()}`);
    }
    const body = await response.json();
    if(body.stop_reason === 'refusal') throw new Error('Claude declined the request');
    const text = (body.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    return json ? parseJson(text) : text;
}

export { isConfigured, complete };
