// AI coach integration entry: readiness check panel + settings.
import { registerPanel } from '../registry.js';
import './views.js';

const element = document.createElement('x-ai-panel');

registerPanel({
    id: 'ai-readiness',
    title: 'Readiness',
    icon: 'heart',
    element,
});

export { element };
