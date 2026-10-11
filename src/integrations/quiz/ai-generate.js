//
// "Generate cards from notes" via the shared Claude client (src/integrations/ai/claude.js).
// Output is validated with makeCards(); nothing is saved until the user approves it.
//

import { isConfigured, complete } from '../ai/claude.js';
import { makeCards } from './cards.js';

const SYSTEM = `You write high-quality spaced-repetition flashcards from a learner's notes.
Rules:
- One atomic fact per card; short questions that can be answered in a few words.
- Cards are reviewed by a cyclist mid-workout (possibly read aloud), so keep text brief, plain, no Markdown, no code blocks.
- Mix types: "basic" (front/back), "cloze" (text with {{c1::answer}} deletions, one deletion per card preferred), and "mcq" (front, 3-4 short choices, answer = zero-based index of the correct choice).
- Only use facts present in the notes. Do not invent.
Respond with JSON only: {"cards":[{"type":"basic","front":"...","back":"..."},{"type":"cloze","text":"... {{c1::...}} ..."},{"type":"mcq","front":"...","choices":["...","..."],"answer":0,"back":"optional short explanation"}]}`;

function buildPrompt(notes, { maxCards = 20, types = ['basic', 'cloze', 'mcq'] } = {}) {
    return `Create at most ${maxCards} cards using these types: ${types.join(', ')}.\n\nNOTES:\n"""\n${String(notes).slice(0, 30000)}\n"""`;
}

// Accepts parsed object, array, or a string that contains JSON
function parseResponse(res) {
    let data = res;
    if(typeof data === 'string') {
        const m = data.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if(!m) return [];
        try { data = JSON.parse(m[0]); } catch(e) { return []; }
    }
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.cards) ? data.cards : []);
    return list.filter(x => x && typeof x === 'object');
}

// -> array of validated card objects (not yet saved)
async function generateCards(notes, { deckId = 'default', maxCards = 20, types, client = { isConfigured, complete } } = {}) {
    if(!client.isConfigured()) throw new Error('AI is not configured (add an Anthropic key in Settings)');
    if(!String(notes || '').trim()) return [];
    const res = await client.complete({
        system: SYSTEM,
        prompt: buildPrompt(notes, { maxCards, types }),
        json: true,
        maxTokens: 4000,
    });
    return parseResponse(res).flatMap(raw => makeCards(raw, { deckId })).slice(0, maxCards * 2);
}

export { SYSTEM, buildPrompt, parseResponse, generateCards, isConfigured };
