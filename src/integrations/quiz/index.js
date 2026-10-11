//
// Quiz integration entry: spaced-repetition review during rides.
// See doc/integrations-contract.md (Quiz section).
//

import { registerPanel } from '../registry.js';
import { session } from './session.js';
import './panel.js';
import './manager.js';

function start() {
    if(typeof window === 'undefined' || !window.indexedDB) return;
    registerPanel({
        id: 'quiz',
        title: 'Quiz',
        icon: 'quiz',
        element: 'x-quiz-panel',
    });
    session.start().catch(err => console.error(':quiz :start', err));
}

start();

export { start };
