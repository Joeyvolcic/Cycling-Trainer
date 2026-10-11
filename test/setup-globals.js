// jsdom lacks TextEncoder/TextDecoder, which @anthropic-ai/sdk needs at import time
const { TextEncoder, TextDecoder } = require('util');

if(typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if(typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
