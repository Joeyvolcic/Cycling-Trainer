// Post-ride analysis & export integration entry point
import { start } from './analysis.js';
import { mount } from './views.js';

function init() {
    start();
    mount();
}

if(document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, {once: true});
} else {
    init();
}
