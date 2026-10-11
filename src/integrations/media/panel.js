//
// <x-media-panel>: in-ride music / podcasts / audiobooks.
// Tabs: Now (big glanceable card) | Library | Search | Local | Ride
//

import { xf } from '../../functions.js';
import * as auth from './spotify-auth.js';
import * as api from './spotify-api.js';
import * as session from './session.js';
import * as web from './web-playback.js';
import * as ride from './ride.js';
import { localPlayer, fileId } from './local-player.js';
import { fetchFeed, parseFeed } from './rss.js';
import {
    escapeHtml as e, formatTime, liveProgress, pickImage, resumeInfo, resumeChapter, toSpotifyUri,
} from './model.js';
import { SEGMENT_TYPES, SEGMENT_LABELS } from './intensity.js';
import { KEYS, lsGet, getPrefs, setPrefs, getPosition, listFeeds, saveFeed, removeFeed } from './store.js';
import { injectStyles } from './styles.js';

const TABS = [
    ['now', 'Now'], ['library', 'Library'], ['search', 'Search'], ['local', 'Local'], ['ride', 'Ride'],
];

function itemRow({action, data = {}, img = '', name = '', desc = '', fraction = null}) {
    const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${e(v)}"`).join(' ');
    const bar = fraction !== null && fraction > 0 ?
          `<div class="mp-bar"><i style="width:${Math.round(fraction * 100)}%"></i></div>` : '';
    return `<li class="mp-item" role="button" tabindex="0" data-action="${action}" ${attrs}>
        ${img ? `<img src="${e(img)}" alt="" loading="lazy">` : '<span class="mp-noart"></span>'}
        <div class="mp-meta"><div class="mp-name">${e(name)}</div>${desc ? `<div class="mp-desc">${e(desc)}</div>` : ''}${bar}</div>
    </li>`;
}

class MediaPanel extends HTMLElement {
    constructor() {
        super();
        this.tab       = 'now';
        this.spotify   = session.snapshot();
        this.local     = localPlayer().state();
        this.segment   = ride.current();
        this.message   = '';
        this.showDevices = false;
        this.libView   = {kind: 'playlists'};
        this.libCache  = {};
        this.searchResults = null;
        this.searchQuery = '';
        this.feed      = null;
        this.feedUrl   = '';
        this.dragging  = false;
        this.handlers  = [];
    }

    connectedCallback() {
        injectStyles();
        this.classList.add('mp');
        this.innerHTML = `
            <nav class="mp-tabs" role="tablist">
                ${TABS.map(([id, label]) => `<button data-action="tab" data-tab="${id}" role="tab">${label}</button>`).join('')}
            </nav>
            <div class="mp-msg err" data-ref="message" hidden></div>
            <div data-ref="body"></div>`;
        this.body = this.querySelector('[data-ref="body"]');
        this.msgEl = this.querySelector('[data-ref="message"]');

        this.onClick  = this.onClick.bind(this);
        this.onInput  = this.onInput.bind(this);
        this.onChange = this.onChange.bind(this);
        this.addEventListener('click', this.onClick);
        this.addEventListener('input', this.onInput);
        this.addEventListener('change', this.onChange);
        this.addEventListener('keydown', ev => {
            if(ev.key === 'Enter' && ev.target.matches('[data-enter]')) {
                ev.preventDefault();
                this.handle(ev.target.dataset.enter, ev.target);
            }
        });

        this.sub('media:spotify', s => { this.spotify = s; if(this.tab === 'now') this.renderNowSoft(); });
        this.sub('media:local',   s => { this.local = s; if(this.tab === 'now') this.renderNowSoft(); });
        this.sub('media:auth',    () => this.render());
        this.sub('media:segment', s => { this.segment = s; if(this.tab === 'now' || this.tab === 'ride') this.render(); });
        this.sub('media:plan',    () => { if(this.tab === 'ride') this.render(); });
        this.sub('media:webplayer', () => { if(this.tab === 'now') this.render(); });
        this.sub('media:error',   msg => this.flash(msg));

        this.ticker = setInterval(() => this.tick(), 1000);
        this.render();
    }

    disconnectedCallback() {
        this.removeEventListener('click', this.onClick);
        this.removeEventListener('input', this.onInput);
        this.removeEventListener('change', this.onChange);
        this.handlers.forEach(([evt, h]) => xf.unsub(evt, h));
        this.handlers = [];
        clearInterval(this.ticker);
    }

    sub(evt, fn) { this.handlers.push([evt, xf.sub(evt, fn)]); }

    flash(msg) {
        this.message = msg || '';
        this.msgEl.hidden = !this.message;
        this.msgEl.textContent = this.message;
        clearTimeout(this.flashTimer);
        if(this.message) this.flashTimer = setTimeout(() => this.flash(''), 8000);
    }

    // Which source the big card shows
    activeSource() {
        const l = this.local, s = this.spotify.np;
        if(l.active && (l.isPlaying || !s.isPlaying)) return l;
        return s;
    }

    render() {
        this.querySelectorAll('.mp-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === this.tab));
        const fn = {now: this.renderNow, library: this.renderLibrary, search: this.renderSearch,
                    local: this.renderLocal, ride: this.renderRide}[this.tab];
        this.body.innerHTML = fn.call(this);
        if(this.tab === 'library') this.ensureLibrary();
        if(this.tab === 'local') this.ensureLocal();
    }

    // re-render the Now tab without fighting a slider the user is touching
    renderNowSoft() {
        if(this.dragging) return;
        const active = document.activeElement;
        if(active && this.contains(active) && active.type === 'range') return;
        this.render();
    }

    tick() {
        if(this.tab !== 'now' || this.dragging) return;
        const np = this.activeSource();
        if(!np.isPlaying) return;
        const ms = np.source === 'local' ? localPlayer().state().progressMs : liveProgress(np);
        const range = this.querySelector('[data-ref="progress"]');
        const cur   = this.querySelector('[data-ref="elapsed"]');
        if(range) range.value = Math.round(ms / 1000);
        if(cur)   cur.textContent = formatTime(ms);
    }

    // ---- Now ---------------------------------------------------------------

    connectBlock() {
        if(!auth.isConfigured()) {
            return `<div class="mp-msg">Spotify is not set up. Add your Spotify app Client ID in
                <b>Settings &rarr; Music &amp; podcasts</b>. You can still play RSS podcasts and local audio files in the <b>Local</b> tab.</div>`;
        }
        if(!auth.isLoggedIn()) {
            const err = auth.status().error;
            return `${err ? `<div class="mp-msg err">${e(err)}</div>` : ''}
                <div class="mp-row"><button class="mp-primary" data-action="login">Connect Spotify</button></div>`;
        }
        return '';
    }

    renderNow() {
        const s = this.spotify;
        const np = this.activeSource();
        const isLocal = np.source === 'local';
        let html = '';

        if(!isLocal) html += this.connectBlock();
        if(s.error && !isLocal) html += `<div class="mp-msg err">${e(s.error)}</div>`;
        if(!isLocal && auth.isLoggedIn() && s.premium === false) {
            html += `<div class="mp-msg">Your Spotify account is Free: Spotify only allows playback control with Premium.
                You can browse here and play in the Spotify app.</div>`;
        }

        const show = isLocal || (auth.isLoggedIn() && np.active && np.title);
        if(show) {
            const progMs = isLocal ? np.progressMs : liveProgress(np);
            const durS = Math.max(1, Math.round((np.durationMs || 0) / 1000));
            const badge = isLocal ? 'Local audio' :
                  `${np.spoken ? 'Podcast / audiobook' : 'Music'}${np.device ? ` &middot; on ${e(np.device.name)}` : ''}`;
            const controls = np.spoken ?
                  `<button data-action="back15" aria-label="Back 15 seconds">&#8634;15</button>
                   <button class="mp-play" data-action="toggle" aria-label="Play/pause">${np.isPlaying ? '&#10074;&#10074;' : '&#9654;'}</button>
                   <button data-action="fwd30" aria-label="Forward 30 seconds">30&#8635;</button>` :
                  `<button data-action="prev" aria-label="Previous">&#9198;</button>
                   <button class="mp-play" data-action="toggle" aria-label="Play/pause">${np.isPlaying ? '&#10074;&#10074;' : '&#9654;'}</button>
                   <button data-action="next" aria-label="Next">&#9197;</button>`;
            const vol = isLocal ? Math.round(localPlayer().audio.volume * 100) :
                  (np.device && np.device.supports_volume !== false ? np.device.volume_percent : null);
            html += `
            <div class="mp-card">
                ${np.art ? `<img class="mp-art" src="${e(np.art)}" alt="">` : '<div class="mp-art"></div>'}
                <div>
                    <div class="mp-title">${e(np.title)}</div>
                    <div class="mp-sub">${e(np.subtitle)}</div>
                    <div class="mp-badge">${badge}</div>
                    <input class="mp-progress" type="range" min="0" max="${durS}" value="${Math.round(progMs / 1000)}"
                           data-ref="progress" data-action="seek" aria-label="Position">
                    <div class="mp-times"><span data-ref="elapsed">${formatTime(progMs)}</span><span>${formatTime(np.durationMs)}</span></div>
                </div>
            </div>
            <div class="mp-controls">${controls}</div>
            ${vol !== null && vol !== undefined ? `<input class="mp-vol" type="range" min="0" max="100" value="${vol}" data-action="volume" aria-label="Volume">` : ''}
            ${isLocal ? this.rateRow() : ''}`;
        } else if(auth.isLoggedIn()) {
            html += `<div class="mp-msg">Nothing playing. Pick something in <b>Library</b> or <b>Search</b>, or choose a device below.</div>`;
        }

        if(auth.isLoggedIn()) {
            html += `<div class="mp-row">
                <button data-action="devices">${this.showDevices ? 'Hide devices' : 'Devices'}</button>
                ${this.local.active ? `<button data-action="local-stop">Close local audio</button>` : ''}
            </div>`;
            if(this.showDevices) html += this.renderDevices();
        }
        html += this.segmentLine();
        return html;
    }

    rateRow() {
        const rate = localPlayer().audio.playbackRate;
        return `<div class="mp-row">${[1, 1.25, 1.5, 2].map(r =>
            `<button data-action="rate" data-rate="${r}" class="${r === rate ? 'mp-primary' : ''}">${r}&times;</button>`).join('')}</div>`;
    }

    renderDevices() {
        const devices = this.spotify.devices || [];
        const w = web.support();
        const list = devices.length ? `<ul class="mp-list">${devices.map(d => itemRow({
            action: 'transfer', data: {id: d.id},
            name: `${d.is_active ? '● ' : ''}${d.name}`,
            desc: `${d.type}${d.is_restricted ? ' (cannot be controlled)' : ''}${d.is_active ? ' - active' : ''}`,
        })).join('')}</ul>` :
              `<div class="mp-msg">No Spotify devices found. Open the Spotify app on this iPad (or your phone/computer),
               start playing anything for a second, then tap Refresh. Devices go to sleep after a while of inactivity.</div>`;
        return `${list}
            <div class="mp-row">
                <button data-action="refresh-devices">Refresh</button>
                <a class="mp-btn" href="spotify:">Open Spotify app</a>
            </div>
            <div class="mp-msg">${e(w.supported ?
                (web.getDeviceId() ? `This browser is available as "${web.DEVICE_NAME}".` : (web.getError() || 'Starting in-browser player...')) :
                w.message)}</div>`;
    }

    segmentLine() {
        const seg = this.segment;
        if(!seg || !seg.type) return '';
        const intensity = ride.getIntensity();
        const pl = seg.playlist ? ` &rarr; ${e(seg.playlist.name || seg.playlist.uri)}` : '';
        return `<div class="mp-seg">Segment: <b>${e(SEGMENT_LABELS[seg.type] || seg.type)}</b>${intensity.enabled ? pl : ' (intensity playlists off)'}</div>`;
    }

    // ---- Library -----------------------------------------------------------

    renderLibrary() {
        const block = this.connectBlock();
        if(block) return block;
        const v = this.libView;
        const nav = `<div class="mp-row">
            ${[['playlists', 'Playlists'], ['shows', 'Podcasts'], ['episodes', 'Saved episodes'], ['audiobooks', 'Audiobooks']]
              .map(([k, l]) => `<button data-action="lib" data-kind="${k}" class="${v.kind === k ? 'mp-primary' : ''}">${l}</button>`).join('')}
        </div>`;
        const back = v.parent ? `<div class="mp-row"><button data-action="lib" data-kind="${v.parent}">&larr; Back</button><b>${e(v.title || '')}</b></div>` : '';
        const data = this.libCache[this.libKey()];
        let content = '<div class="mp-msg">Loading...</div>';
        if(data && data.error) content = `<div class="mp-msg err">${e(data.error)}</div>`;
        else if(data) content = this.libList(v, data.items);
        return nav + back + content;
    }

    libKey() { const v = this.libView; return `${v.kind}:${v.id || ''}`; }

    async ensureLibrary() {
        const key = this.libKey();
        if(this.libCache[key] || !auth.isLoggedIn()) return;
        const v = this.libView;
        try {
            let items = [];
            if(v.kind === 'playlists')  items = (await api.playlists()).items;
            if(v.kind === 'shows')      items = (await api.savedShows()).items.map(i => i.show);
            if(v.kind === 'episodes')   items = (await api.savedEpisodes()).items.map(i => i.episode);
            if(v.kind === 'audiobooks') items = (await api.savedAudiobooks()).items.map(i => i.audiobook || i);
            if(v.kind === 'show')       items = (await api.showEpisodes(v.id)).items;
            if(v.kind === 'book')       items = (await api.audiobookChapters(v.id)).items;
            this.libCache[key] = {items: (items || []).filter(Boolean)};
        } catch(err) {
            let msg = err.message;
            if(v.kind === 'audiobooks' || v.kind === 'book') {
                msg = `Audiobooks are not available for this account or country (Spotify offers them in select markets only). ${err.status ? `(${err.status})` : ''}`;
            }
            this.libCache[key] = {error: msg};
        }
        if(this.tab === 'library' && this.libKey() === key) this.render();
    }

    libList(v, items) {
        if(!items.length) {
            const empty = {
                audiobooks: 'No saved audiobooks. Audiobooks are only in some Spotify markets; save some in the Spotify app.',
                shows: 'No followed podcasts yet.',
                episodes: 'No saved episodes.',
            }[v.kind] || 'Nothing here.';
            return `<div class="mp-msg">${empty}</div>`;
        }
        const rows = items.map(it => {
            switch(v.kind) {
            case 'playlists':
                return itemRow({action: 'play-context', data: {uri: it.uri}, img: pickImage(it.images, 64),
                                name: it.name, desc: `${it.owner?.display_name || ''}${it.tracks?.total ? ` - ${it.tracks.total} tracks` : ''}`});
            case 'shows':
                return itemRow({action: 'open-show', data: {id: it.id, name: it.name}, img: pickImage(it.images, 64),
                                name: it.name, desc: it.publisher});
            case 'audiobooks':
                return itemRow({action: 'open-book', data: {id: it.id, name: it.name}, img: pickImage(it.images, 64),
                                name: it.name, desc: (it.authors || []).map(a => a.name).join(', ')});
            case 'episodes':
            case 'show': {
                const r = resumeInfo(it);
                return itemRow({action: 'play-episode', data: {uri: it.uri, pos: r.positionMs}, img: pickImage(it.images, 64),
                                name: it.name, desc: `${it.release_date || ''} - ${formatTime(it.duration_ms)}${r.fullyPlayed ? ' - played' : r.positionMs ? ` - resume at ${formatTime(r.positionMs)}` : ''}`,
                                fraction: r.fraction});
            }
            case 'book': {
                const r = resumeInfo(it);
                return itemRow({action: 'play-chapter', data: {uri: it.uri, book: v.uri || '', pos: r.positionMs}, img: pickImage(it.images, 64),
                                name: it.name, desc: `${formatTime(it.duration_ms)}${r.positionMs ? ` - resume at ${formatTime(r.positionMs)}` : ''}`,
                                fraction: r.fraction});
            }
            }
            return '';
        }).join('');
        const resume = v.kind === 'book' ? `<div class="mp-row"><button class="mp-primary" data-action="resume-book">Resume book</button></div>` : '';
        return `${resume}<ul class="mp-list">${rows}</ul>`;
    }

    // ---- Search ------------------------------------------------------------

    renderSearch() {
        const block = this.connectBlock();
        if(block) return block;
        let html = `<div class="mp-row">
            <input type="search" data-ref="q" data-enter="search" placeholder="Songs, playlists, podcasts, audiobooks" value="${e(this.searchQuery)}">
            <button class="mp-primary" data-action="search">Search</button>
        </div>`;
        const r = this.searchResults;
        if(!r) return html;
        if(r.error) return html + `<div class="mp-msg err">${e(r.error)}</div>`;
        const section = (title, items, fn) => {
            const list = (items || []).filter(Boolean);
            return list.length ? `<div class="mp-h">${title}</div><ul class="mp-list">${list.map(fn).join('')}</ul>` : '';
        };
        html += section('Songs', r.tracks?.items, t => itemRow({action: 'play-track', data: {uri: t.uri},
            img: pickImage(t.album?.images, 64), name: t.name, desc: (t.artists || []).map(a => a.name).join(', ')}));
        html += section('Playlists', r.playlists?.items, p => itemRow({action: 'play-context', data: {uri: p.uri},
            img: pickImage(p.images, 64), name: p.name, desc: p.owner?.display_name || ''}));
        html += section('Podcasts', r.shows?.items, s => itemRow({action: 'open-show', data: {id: s.id, name: s.name},
            img: pickImage(s.images, 64), name: s.name, desc: s.publisher}));
        html += section('Episodes', r.episodes?.items, ep => {
            const ri = resumeInfo(ep);
            return itemRow({action: 'play-episode', data: {uri: ep.uri, pos: ri.positionMs},
                img: pickImage(ep.images, 64), name: ep.name, desc: `${ep.release_date || ''} - ${formatTime(ep.duration_ms)}`, fraction: ri.fraction});
        });
        const books = (r.audiobooks?.items || []).filter(Boolean);
        html += books.length ? section('Audiobooks', books, b => itemRow({action: 'open-book', data: {id: b.id, name: b.name},
            img: pickImage(b.images, 64), name: b.name, desc: (b.authors || []).map(a => a.name).join(', ')})) :
            (r.audiobooksUnavailable ? '<div class="mp-msg">Audiobooks are not available in your Spotify market.</div>' : '');
        return html;
    }

    async doSearch(q) {
        this.searchQuery = q;
        if(!q.trim()) return;
        this.searchResults = null;
        this.render();
        try {
            let res;
            try {
                res = await api.search(q);
            } catch(err) {
                // some markets reject type=audiobook: retry without it
                res = await api.search(q, ['track', 'playlist', 'show', 'episode']);
                res.audiobooksUnavailable = true;
            }
            this.searchResults = res || {};
        } catch(err) {
            this.searchResults = {error: err.message};
        }
        if(this.tab === 'search') this.render();
    }

    // ---- Local -------------------------------------------------------------

    renderLocal() {
        const feeds = this.feeds || [];
        let html = `
        <div class="mp-msg">Play podcasts from any RSS feed, or your own audio files (e.g. audiobooks), without Spotify.
            Positions are remembered on this device.</div>
        <div class="mp-h">Podcast RSS feed</div>
        <div class="mp-row">
            <input type="url" data-ref="feed-url" data-enter="load-feed" placeholder="https://example.com/feed.xml" value="${e(this.feedUrl)}">
            <button class="mp-primary" data-action="load-feed">Load</button>
        </div>
        <div class="mp-row">
            <label class="mp-btn">Open feed .xml file<input type="file" accept=".xml,.rss,application/rss+xml,text/xml" data-action="feed-file" hidden></label>
        </div>
        <div class="mp-h">Audio URL</div>
        <div class="mp-row">
            <input type="url" data-ref="audio-url" data-enter="play-url" placeholder="https://.../episode.mp3">
            <button data-action="play-url">Play</button>
        </div>
        <div class="mp-h">Audio file (audiobook, podcast)</div>
        <div class="mp-row">
            <label class="mp-btn mp-primary">Choose audio file<input type="file" accept="audio/*,.mp3,.m4a,.m4b,.aac,.ogg,.opus,.wav" data-action="audio-file" hidden></label>
        </div>`;
        if(feeds.length) {
            html += `<div class="mp-h">Saved feeds</div><ul class="mp-list">${feeds.map(f =>
                `<li class="mp-item" data-action="open-feed" data-url="${e(f.url)}" role="button" tabindex="0">
                    ${f.image ? `<img src="${e(f.image)}" alt="" loading="lazy">` : '<span class="mp-noart"></span>'}
                    <div class="mp-meta"><div class="mp-name">${e(f.title)}</div><div class="mp-desc">${e(f.url)}</div></div>
                    <button data-action="remove-feed" data-url="${e(f.url)}" aria-label="Remove feed">&times;</button>
                </li>`).join('')}</ul>`;
        }
        if(this.feed) {
            if(this.feed.error) {
                html += `<div class="mp-msg err">${e(this.feed.error)}</div>`;
            } else if(this.feed.loading) {
                html += `<div class="mp-msg">Loading feed...</div>`;
            } else {
                const pos = this.feedPositions || {};
                html += `<div class="mp-h">${e(this.feed.title)}</div><ul class="mp-list">${this.feed.episodes.slice(0, 100).map((ep, i) => {
                    const p = pos[ep.id];
                    const dur = (p && p.duration) || ep.duration;
                    const frac = p && dur ? Math.min(1, p.position / dur) : null;
                    return itemRow({action: 'play-feed-episode', data: {index: i}, img: ep.image, name: ep.title,
                        desc: `${ep.pubDate ? new Date(ep.pubDate).toLocaleDateString() : ''}${dur ? ` - ${formatTime(dur * 1000)}` : ''}${p && p.position ? ` - resume at ${formatTime(p.position * 1000)}` : ''}`,
                        fraction: frac});
                }).join('')}</ul>`;
            }
        }
        return html;
    }

    async ensureLocal() {
        if(this.feeds) return;
        this.feeds = await listFeeds();
        if(this.tab === 'local') this.render();
    }

    async loadFeed(url, {xml = null} = {}) {
        this.feedUrl = url || '';
        this.feed = {loading: true};
        this.render();
        try {
            const feed = xml ? parseFeed(xml) : await fetchFeed(url, {proxyTemplate: lsGet(KEYS.corsProxy, '')});
            feed.url = url;
            this.feed = feed;
            if(url) {
                await saveFeed({url, title: feed.title, image: feed.image});
                this.feeds = await listFeeds();
            }
            const positions = {};
            await Promise.all(feed.episodes.slice(0, 100).map(async ep => {
                const p = await getPosition(ep.id);
                if(p) positions[ep.id] = p;
            }));
            this.feedPositions = positions;
        } catch(err) {
            this.feed = {error: err.message};
        }
        if(this.tab === 'local') this.render();
    }

    // ---- Ride --------------------------------------------------------------

    renderRide() {
        const intensity = ride.getIntensity();
        const prefs = getPrefs();
        const playlists = (this.libCache['playlists:'] && this.libCache['playlists:'].items) || [];
        if(auth.isLoggedIn() && !this.libCache['playlists:']) {
            this.libView = this.libView || {kind: 'playlists'};
            api.playlists().then(r => { this.libCache['playlists:'] = {items: r.items.filter(Boolean)}; if(this.tab === 'ride') this.render(); })
                .catch(err => { this.libCache['playlists:'] = {error: err.message, items: []}; });
        }
        const rows = SEGMENT_TYPES.map(type => {
            const cur = intensity.mapping[type] || {};
            const inList = playlists.some(p => p.uri === cur.uri);
            const options = [`<option value="">- none -</option>`]
                .concat(cur.uri && !inList ? [`<option value="${e(cur.uri)}" selected>${e(cur.name || cur.uri)}</option>`] : [])
                .concat(playlists.map(p => `<option value="${e(p.uri)}" ${p.uri === cur.uri ? 'selected' : ''}>${e(p.name)}</option>`));
            return `<div class="mp-h">${e(SEGMENT_LABELS[type])}</div>
                <div class="mp-row">
                    <select data-action="map-select" data-type="${type}">${options.join('')}</select>
                    <input type="text" data-action="map-uri" data-type="${type}" placeholder="or paste Spotify playlist link">
                </div>`;
        }).join('');

        const plan = ride.getPlan();
        const counts = plan.reduce((acc, t) => { if(t) acc[t] = (acc[t] || 0) + 1; return acc; }, {});
        const planLine = plan.length ?
              `<div class="mp-seg">Loaded workout: ${plan.length} intervals &middot; ${Object.entries(counts).map(([t, n]) => `${e(SEGMENT_LABELS[t])} ${n}`).join(', ')}</div>` :
              `<div class="mp-seg">No workout loaded.</div>`;

        return `
            <label class="mp-toggle"><input type="checkbox" data-action="pref" data-pref="autoPauseSpoken" ${prefs.autoPauseSpoken ? 'checked' : ''}>
                Pause podcasts &amp; audiobooks when the workout pauses</label>
            <label class="mp-toggle"><input type="checkbox" data-action="pref" data-pref="autoResume" ${prefs.autoResume ? 'checked' : ''}>
                Resume them when the workout resumes</label>
            <div class="mp-h">Intensity playlists</div>
            <label class="mp-toggle"><input type="checkbox" data-action="intensity-enabled" ${intensity.enabled ? 'checked' : ''}>
                Switch Spotify playlist when the workout interval changes</label>
            <div class="mp-msg">Segment type comes from the interval's power target (% FTP): recovery &lt;56%, endurance 56-75%,
                tempo/threshold 76-105%, VO2 &gt;105%. Easy intervals at the start are warm-up, at the end cool-down.
                Short rests between hard efforts keep the hard playlist. Podcasts/audiobooks are never interrupted.</div>
            ${auth.isLoggedIn() ? rows : this.connectBlock()}
            ${planLine}
            ${this.segmentLine()}`;
    }

    saveMapping(type, uri, name) {
        const intensity = ride.getIntensity();
        const mapping = Object.assign({}, intensity.mapping);
        if(uri) mapping[type] = {uri, name: name || uri};
        else delete mapping[type];
        ride.setIntensity({mapping});
    }

    // ---- events ------------------------------------------------------------

    onInput(ev) {
        const el = ev.target;
        if(el.dataset.action === 'seek') {
            this.dragging = true;
            const cur = this.querySelector('[data-ref="elapsed"]');
            if(cur) cur.textContent = formatTime(Number(el.value) * 1000);
        }
    }

    onChange(ev) {
        const el = ev.target;
        const action = el.dataset.action;
        if(!action) return;
        if(action === 'seek') {
            this.dragging = false;
            const ms = Number(el.value) * 1000;
            if(this.activeSource().source === 'local') localPlayer().seek(ms / 1000);
            else session.seekTo(ms);
        }
        if(action === 'volume') {
            const v = Number(el.value);
            if(this.activeSource().source === 'local') localPlayer().setVolume(v / 100);
            else session.setVolume(v);
        }
        if(action === 'pref') setPrefs({[el.dataset.pref]: el.checked});
        if(action === 'intensity-enabled') ride.setIntensity({enabled: el.checked});
        if(action === 'map-select') {
            const opt = el.selectedOptions[0];
            this.saveMapping(el.dataset.type, el.value, opt ? opt.textContent : '');
        }
        if(action === 'map-uri') {
            const uri = toSpotifyUri(el.value);
            if(!uri) { this.flash('That does not look like a Spotify playlist link.'); return; }
            this.saveMapping(el.dataset.type, uri, uri);
            this.render();
        }
        if(action === 'audio-file' && el.files && el.files[0]) {
            const file = el.files[0];
            localPlayer().load({id: fileId(file), title: file.name.replace(/\.[^.]+$/, ''), subtitle: 'Local file', file});
            this.tab = 'now';
            this.render();
        }
        if(action === 'feed-file' && el.files && el.files[0]) {
            el.files[0].text().then(xml => this.loadFeed('', {xml}));
        }
    }

    onClick(ev) {
        const el = ev.target.closest('[data-action]');
        if(!el || !this.contains(el)) return;
        if(el.tagName === 'INPUT' || el.tagName === 'SELECT') return; // handled by change
        ev.preventDefault();
        if(el.dataset.action === 'remove-feed') ev.stopPropagation();
        this.handle(el.dataset.action, el);
    }

    async handle(action, el) {
        const d = el.dataset;
        const lp = localPlayer();
        const isLocal = this.activeSource().source === 'local';
        switch(action) {
        case 'tab':        this.tab = d.tab; this.render(); break;
        case 'login':      auth.login().catch(err => this.flash(err.message)); break;
        case 'toggle':     isLocal ? lp.toggle() : session.togglePlay(); break;
        case 'prev':       session.previous(); break;
        case 'next':       session.next(); break;
        case 'back15':     isLocal ? lp.skip(-15) : session.skipBy(-15); break;
        case 'fwd30':      isLocal ? lp.skip(30) : session.skipBy(30); break;
        case 'rate':       lp.setRate(Number(d.rate)); this.render(); break;
        case 'local-stop': lp.unload(); this.render(); break;
        case 'devices':
            this.showDevices = !this.showDevices;
            if(this.showDevices) session.refreshDevices();
            this.render();
            break;
        case 'refresh-devices': session.refreshDevices(); break;
        case 'transfer':   await session.transferTo(d.id); break;
        case 'lib':        this.libView = {kind: d.kind}; this.render(); break;
        case 'open-show':  this.tab = 'library'; this.libView = {kind: 'show', id: d.id, title: d.name, parent: 'shows'}; this.render(); break;
        case 'open-book':  this.tab = 'library'; this.libView = {kind: 'book', id: d.id, uri: `spotify:audiobook:${d.id}`, title: d.name, parent: 'audiobooks'}; this.render(); break;
        case 'play-context': this.playSpotify({contextUri: d.uri}); break;
        case 'play-track':   this.playSpotify({uris: [d.uri]}); break;
        case 'play-episode': this.playSpotify({uris: [d.uri], positionMs: Number(d.pos) || 0}); break;
        case 'play-chapter':
            this.playSpotify(d.book ? {contextUri: d.book, offsetUri: d.uri, positionMs: Number(d.pos) || 0}
                                    : {uris: [d.uri], positionMs: Number(d.pos) || 0});
            break;
        case 'resume-book': {
            const data = this.libCache[this.libKey()];
            const r = resumeChapter(data?.items || []);
            if(r) this.playSpotify({contextUri: this.libView.uri, offsetUri: r.chapter.uri, positionMs: r.positionMs});
            break;
        }
        case 'search': {
            const q = this.querySelector('[data-ref="q"]');
            this.doSearch(q ? q.value : '');
            break;
        }
        case 'load-feed': {
            const input = this.querySelector('[data-ref="feed-url"]');
            const url = (input?.value || '').trim();
            if(url) this.loadFeed(url);
            break;
        }
        case 'open-feed':   this.loadFeed(d.url); break;
        case 'remove-feed':
            await removeFeed(d.url);
            this.feeds = await listFeeds();
            this.render();
            break;
        case 'play-url': {
            const input = this.querySelector('[data-ref="audio-url"]');
            const url = (input?.value || '').trim();
            if(!url) break;
            lp.load({id: `url:${url}`, title: decodeURIComponent(url.split('/').pop().split('?')[0]) || url, subtitle: 'Audio URL', url});
            this.tab = 'now';
            this.render();
            break;
        }
        case 'play-feed-episode': {
            const ep = this.feed?.episodes?.[Number(d.index)];
            if(!ep) break;
            lp.load({id: ep.id, title: ep.title, subtitle: this.feed.title, art: ep.image, url: ep.url});
            this.tab = 'now';
            this.render();
            break;
        }
        }
    }

    async playSpotify(opts) {
        if(this.local.isPlaying) localPlayer().pause();
        await session.playItem(opts);
        this.tab = 'now';
        this.render();
    }
}

if(!customElements.get('x-media-panel')) customElements.define('x-media-panel', MediaPanel);

export { MediaPanel };
