//
// <x-media-settings>: Spotify Client ID, connect/disconnect, redirect URI help, CORS proxy.
//

import { xf } from '../../functions.js';
import * as auth from './spotify-auth.js';
import * as session from './session.js';
import * as web from './web-playback.js';
import { escapeHtml as e } from './model.js';
import { KEYS, lsGet, lsSet, getPrefs, setPrefs } from './store.js';
import { injectStyles } from './styles.js';

class MediaSettings extends HTMLElement {
    connectedCallback() {
        injectStyles();
        this.classList.add('mp');
        this.handlers = [
            ['media:auth', xf.sub('media:auth', () => this.render())],
            ['media:spotify', xf.sub('media:spotify', s => { if(s.profile !== this.profile) { this.profile = s.profile; this.render(); } })],
            ['media:webplayer', xf.sub('media:webplayer', () => this.render())],
        ];
        this.onClick = this.onClick.bind(this);
        this.addEventListener('click', this.onClick);
        this.addEventListener('change', ev => {
            if(ev.target.dataset.pref) setPrefs({[ev.target.dataset.pref]: ev.target.checked});
        });
        this.profile = session.state.profile;
        this.render();
    }

    disconnectedCallback() {
        (this.handlers || []).forEach(([evt, h]) => xf.unsub(evt, h));
        this.removeEventListener('click', this.onClick);
    }

    render() {
        const st = auth.status();
        const prefs = getPrefs();
        const w = web.support();
        const p = this.profile;
        const account = st.loggedIn ?
              `<div class="mp-msg">Connected${p ? ` as <b>${e(p.display_name || p.id)}</b> (${p.product === 'premium' ? 'Premium' : `${e(p.product || 'unknown')} - playback control needs Premium`})` : ''}.</div>
               <div class="mp-row"><button data-action="logout">Disconnect Spotify</button></div>` :
              `<div class="mp-row"><button class="mp-primary" data-action="login" ${st.configured ? '' : 'disabled'}>Connect Spotify</button></div>`;

        this.innerHTML = `
        <div class="settings-tile--label">Music &amp; podcasts (Spotify)</div>
        ${st.error ? `<div class="mp-msg err">${e(st.error)}</div>` : ''}
        <details ${st.configured ? '' : 'open'}>
            <summary class="mp-btn">How to set up Spotify</summary>
            <ol>
                <li>Go to <b>developer.spotify.com/dashboard</b>, log in, <b>Create app</b>.</li>
                <li>Add this exact <b>Redirect URI</b>: <code>${e(st.redirectUri)}</code>
                    <button data-action="copy">Copy</button><br>
                    Spotify only accepts HTTPS, or <code>http://127.0.0.1:PORT</code> for local development
                    (<code>http://localhost</code> is rejected).</li>
                <li>Tick <b>Web API</b> and <b>Web Playback SDK</b>, save, then copy the app's <b>Client ID</b> below.
                    No client secret is needed (PKCE).</li>
                <li>While the app is in development mode, add your Spotify account's e-mail under <b>User Management</b>.</li>
                <li>Playback control (play/pause/skip, playlists switching) requires <b>Spotify Premium</b>.</li>
            </ol>
        </details>
        <div class="mp-row">
            <input type="text" data-ref="client-id" placeholder="Spotify Client ID" autocomplete="off" autocapitalize="off" spellcheck="false"
                   value="${e(auth.getClientId())}">
            <button data-action="save-client">Save</button>
        </div>
        ${account}
        <details>
            <summary class="mp-btn">Login came back in Safari instead of the app?</summary>
            <div class="mp-msg">Copy the full address from Safari (it contains <code>?code=</code>) and paste it here.</div>
            <div class="mp-row">
                <input type="url" data-ref="callback" placeholder="https://...?code=...&state=spotify_...">
                <button data-action="paste-callback">Finish login</button>
            </div>
        </details>
        <div class="mp-msg">${e(w.message)}${w.supported && web.getError() ? ` ${e(web.getError())}` : ''}</div>
        ${w.supported ? `<label class="mp-toggle"><input type="checkbox" data-pref="useWebPlayer" ${prefs.useWebPlayer ? 'checked' : ''}>
            Use this browser as a Spotify player ("${web.DEVICE_NAME}")</label>` : ''}
        <div class="mp-h">CORS proxy for podcast RSS feeds (optional)</div>
        <div class="mp-msg">Many podcast hosts block feed downloads from web apps (CORS). If a feed won't load, you can set a
            proxy you trust, e.g. <code>https://your-proxy.example/?url={url}</code>. Episode audio plays without it.</div>
        <div class="mp-row">
            <input type="url" data-ref="proxy" placeholder="https://your-proxy.example/?url={url}" value="${e(lsGet(KEYS.corsProxy, '') || '')}">
            <button data-action="save-proxy">Save</button>
        </div>`;
    }

    async onClick(ev) {
        const el = ev.target.closest('[data-action]');
        if(!el) return;
        const action = el.dataset.action;
        if(action === 'save-client') {
            auth.setClientId(this.querySelector('[data-ref="client-id"]').value);
            this.render();
        }
        if(action === 'login') {
            try { await auth.login(); } catch(err) { alert(err.message); }
        }
        if(action === 'logout') { auth.logout(); }
        if(action === 'copy') {
            try { await navigator.clipboard.writeText(auth.getRedirectUri()); el.textContent = 'Copied'; }
            catch(err) { el.textContent = 'Select & copy manually'; }
        }
        if(action === 'paste-callback') {
            const url = this.querySelector('[data-ref="callback"]').value.trim();
            const handled = await auth.handleCallback(url);
            if(!handled) alert('That URL has no Spotify login code in it.');
            this.render();
        }
        if(action === 'save-proxy') {
            lsSet(KEYS.corsProxy, this.querySelector('[data-ref="proxy"]').value.trim() || null);
            el.textContent = 'Saved';
        }
    }
}

if(!customElements.get('x-media-settings')) customElements.define('x-media-settings', MediaSettings);

export { MediaSettings };
