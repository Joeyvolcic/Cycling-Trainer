import { xf } from '../functions.js';

// Panels shown in the integrations dock next to the workout (see doc/integrations-contract.md)
const panels = new Map();

function registerPanel({id, title, icon = '', element}) {
    panels.set(id, {id, title, icon, element});
    xf.dispatch('integrations:panels', listPanels());
}

function listPanels() {
    return Array.from(panels.values());
}

export { registerPanel, listPanels };
