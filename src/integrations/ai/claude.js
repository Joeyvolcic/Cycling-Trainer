// STUB — real implementation comes from the AI branch
//
// Contract (doc/integrations-contract.md):
//   isConfigured() -> boolean
//   async complete({system, prompt, json = false, maxTokens}) -> string | parsed object when json

function isConfigured() {
    try {
        return !!localStorage.getItem('ai:anthropic-key');
    } catch(e) {
        return false;
    }
}

async function complete({system, prompt, json = false, maxTokens} = {}) {
    throw new Error('AI client not available in this build (stub)');
}

export { isConfigured, complete };
