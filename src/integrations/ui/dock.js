import { xf } from '../../functions.js';
import { listPanels } from '../registry.js';

// Integrations dock: renders the panels registered through src/integrations/registry.js
// into <div id="integrations-dock"> with a touch-friendly tab switcher.
//
// Panels are created lazily the first time they are shown and then kept mounted
// (hidden) so that e.g. a playing podcast or a quiz in progress keeps its state.

const ACTIVE_KEY = 'ui:dock-panel';

// registerPanel({element}) may be a tag name, an element instance, an element class
// or a factory function. Normalise to an HTMLElement.
function createPanelElement(element, doc = document) {
    if(!element) return undefined;
    if(typeof element === 'string') return doc.createElement(element);
    if(typeof Node !== 'undefined' && element instanceof Node) return element;
    if(typeof element === 'function') {
        if(typeof HTMLElement !== 'undefined' && element.prototype instanceof HTMLElement) {
            return new element();
        }
        return element();
    }
    return undefined;
}

function pickActive(panels, preferred) {
    if(panels.some(p => p.id === preferred)) return preferred;
    return panels[0]?.id;
}

function escapeHtml(str = '') {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

function iconHtml(icon = '') {
    if(!icon) return '';
    // inline svg markup from our own panels, otherwise treat as text (emoji / letter)
    if(String(icon).trim().startsWith('<svg')) return icon;
    return escapeHtml(icon);
}

class IntegrationsDock {
    constructor(root) {
        this.root    = root;
        this.panels  = [];
        this.mounted = new Map(); // id -> host element
        this.active  = this.restore();

        root.classList.add('integrations-dock');
        root.innerHTML =
            `<div class="dock--tabs" role="tablist" aria-label="Integrations"></div>
             <div class="dock--panels"></div>
             <div class="dock--empty">
                 <p class="dock--empty--title">Integrations</p>
                 <p class="dock--empty--text">Music, podcasts, quizzes, your coach and calendar will show up here.</p>
             </div>`;
        this.$tabs   = root.querySelector('.dock--tabs');
        this.$panels = root.querySelector('.dock--panels');

        this.$tabs.addEventListener('click', e => {
            const btn = e.target.closest('[data-panel]');
            if(btn) this.select(btn.dataset.panel);
        });

        xf.sub('integrations:panels', panels => this.update(panels));
        xf.sub('ui:dock:select', id => this.select(id));

        this.update(listPanels());
    }
    restore() {
        try { return localStorage.getItem(ACTIVE_KEY) ?? undefined; } catch(e) { return undefined; }
    }
    backup(id) {
        try { localStorage.setItem(ACTIVE_KEY, id); } catch(e) { /* ignore */ }
    }
    update(panels = []) {
        this.panels = panels;
        this.root.classList.toggle('empty', panels.length === 0);
        document.body.classList.toggle('has-dock-panels', panels.length > 0);
        this.active = pickActive(panels, this.active);
        this.renderTabs();
        this.show(this.active);
    }
    select(id) {
        if(!this.panels.some(p => p.id === id)) return;
        this.active = id;
        this.backup(id);
        this.renderTabs();
        this.show(id);
        xf.dispatch('integrations:active', id);
    }
    renderTabs() {
        this.$tabs.classList.toggle('single', this.panels.length < 2);
        this.$tabs.innerHTML = this.panels.map(p => {
            const active = p.id === this.active;
            return `<button type="button" class="dock--tab ${active ? 'active' : ''}"
                            role="tab" aria-selected="${active}" data-panel="${escapeHtml(p.id)}">
                        ${p.icon ? `<span class="dock--tab--icon" aria-hidden="true">${iconHtml(p.icon)}</span>` : ''}
                        <span class="dock--tab--title">${escapeHtml(p.title ?? p.id)}</span>
                    </button>`;
        }).join('');
    }
    show(id) {
        if(id && !this.mounted.has(id)) {
            const panel = this.panels.find(p => p.id === id);
            let el;
            try {
                el = createPanelElement(panel?.element);
            } catch(e) {
                console.error(`integrations-dock: failed to create panel '${id}'`, e);
            }
            if(el) {
                const host = document.createElement('section');
                host.className = 'dock--panel';
                host.setAttribute('role', 'tabpanel');
                host.dataset.panel = id;
                host.appendChild(el);
                this.$panels.appendChild(host);
                this.mounted.set(id, host);
            }
        }
        // drop hosts for panels that were unregistered
        for(const [key, host] of this.mounted) {
            if(!this.panels.some(p => p.id === key)) {
                host.remove();
                this.mounted.delete(key);
                continue;
            }
            host.hidden = key !== id;
        }
    }
}

function start() {
    if(typeof document === 'undefined') return;
    const root = document.getElementById('integrations-dock');
    if(!root || root.__dock) return;
    root.__dock = new IntegrationsDock(root);
    return root.__dock;
}

export { createPanelElement, pickActive, IntegrationsDock, start };
