import { xf } from '../../functions.js';

//
// Collapsible "Integrations" sections on the Settings page
// (<details class="integration-section" data-section="<name>"> in index.html).
//
// - The open/closed state of each section is remembered in localStorage['ui:settings-open'].
// - xf.dispatch('ui:settings:open', '<name>') opens a section and scrolls to it
//   (e.g. 'analysis', 'ai', 'calendar', 'media', 'quiz', 'hr-control'); the
//   name may also be a settings element id like 'analysis-settings'.
// - A URL hash pointing inside a section (#analysis-settings) opens it on load.
//

const STORAGE_KEY = 'ui:settings-open';

function readOpen() {
    try {
        const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
        return Array.isArray(value) ? value : [];
    } catch(e) {
        return [];
    }
}

function writeOpen(names) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
    } catch(e) { /* storage unavailable */ }
}

function sections(root = document) {
    return Array.from(root.querySelectorAll('details.integration-section[data-section]'));
}

function findSection(name, root = document) {
    if(!name) return null;
    const key = String(name).replace(/^#/, '');
    return sections(root).find(d => d.dataset.section === key) ??
           root.getElementById?.(key)?.closest?.('details.integration-section') ??
           null;
}

function openSection(name, {scroll = true, root = document} = {}) {
    const details = findSection(name, root);
    if(!details) return null;
    details.open = true;
    if(scroll) {
        setTimeout(() => details.scrollIntoView?.({behavior: 'smooth', block: 'start'}), 100);
    }
    return details;
}

function start(root = document) {
    const remembered = new Set(readOpen());

    for(const details of sections(root)) {
        if(remembered.has(details.dataset.section)) details.open = true;
        details.addEventListener('toggle', () => {
            const open = new Set(readOpen());
            if(details.open) {
                open.add(details.dataset.section);
            } else {
                open.delete(details.dataset.section);
            }
            writeOpen(Array.from(open));
        });
    }

    if(typeof location !== 'undefined' && location.hash) {
        openSection(location.hash, {scroll: false, root});
    }

    xf.sub('ui:settings:open', name => openSection(name, {root}));
}

export { start, openSection, findSection, STORAGE_KEY };
