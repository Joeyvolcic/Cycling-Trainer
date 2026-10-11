//
// Post-ride report (modal sheet), dock panel and settings section.
//

import { xf } from '../../functions.js';
import { registerPanel } from '../registry.js';
import * as analysis from './analysis.js';
import * as settings from './settings.js';
import { SERVICE_LABELS } from './uploaders.js';
import { injectStyles } from './styles.js';

const GARMIN_IMPORT_URL = 'https://connect.garmin.com/modern/import-data';
const ZONE_COLORS = ['#636468', '#328AFF', '#44A5AB', '#57C057', '#F8C73A', '#FF663A', '#FE340B'];

const ROUTE_LABELS = {
    'strava-direct': 'your Strava app',
    'intervals-direct': 'API key',
    'auuki': 'Auuki account',
};

function esc(x) {
    return String(x ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function fmtDuration(sec) {
    if(sec === null || sec === undefined) return '--';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function v(x, unit = '') {
    return (x === null || x === undefined) ? '--' : `${x}${unit}`;
}

function tile(label, value) {
    return `<div class="an-tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
}

function zoneBars(zones) {
    if(!zones) return '';
    return `<div class="an-bars">${zones.map((z, i) => `
        <div class="an-bar">
            <span>${esc(z.zone)}</span>
            <div class="track"><div class="fill" style="width:${z.pct}%;background:${ZONE_COLORS[i] ?? '#888'}"></div></div>
            <span>${fmtDuration(z.seconds)}</span>
        </div>`).join('')}</div>`;
}

function statusLabel(status) {
    return {
        'on-target': 'on target', 'under': 'under', 'over': 'over', 'no-target': '—',
        'done': 'uploaded', 'pending': 'queued', 'uploading': 'uploading',
        'needs-setup': 'needs setup', 'failed': 'failed',
    }[status] ?? status;
}

// --- report sheet ------------------------------------------------------------

class AnalysisReport extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.className = 'an-overlay';
        this.activityId = null;
        this.report = null;
        this.busy = false;
        this.coachError = '';

        xf.sub('analysis:report', ({id, fresh}) => this.open(id, fresh), signal);
        xf.sub('analysis:report:open', (id) => this.open(id), signal);
        xf.sub('analysis:upload', (job) => {
            if(this.isOpen() && job.activityId === this.activityId) this.refresh();
        }, signal);
        xf.sub('analysis:changed', ({id}) => {
            if(this.isOpen() && id === this.activityId && !this.busy) this.refresh();
        }, signal);

        this.addEventListener('click', this.onClick.bind(this), signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    isOpen() {
        return this.classList.contains('open');
    }
    async open(id, fresh = false) {
        if(!id) return;
        this.activityId = id;
        this.fresh = fresh;
        this.coachError = '';
        this.classList.add('open');
        await this.refresh();
        this.scrollTop = 0;
    }
    close() {
        this.classList.remove('open');
        this.innerHTML = '';
        this.activityId = null;
    }
    async refresh() {
        this.report = await analysis.getReport(this.activityId);
        this.render();
    }
    onClick(e) {
        if(e.target === this) { this.close(); return; }
        const el = e.target.closest('[data-action]');
        if(!el) return;
        const action = el.dataset.action;
        const id = this.activityId;
        if(action === 'close') this.close();
        if(action === 'upload') this.onUpload();
        if(action === 'download') analysis.downloadFit(id);
        if(action === 'share') analysis.shareFit(id);
        if(action === 'retry') analysis.queue.retry(el.dataset.job);
        if(action === 'coach') this.onCoach();
        if(action === 'settings') {
            this.close();
            xf.dispatch('ui:page-set', 'settings');
            xf.dispatch('action:nav', 'settings:settings');
            setTimeout(() => document.getElementById('analysis-settings')?.scrollIntoView({behavior: 'smooth'}), 100);
        }
    }
    selectedServices() {
        return Array.from(this.querySelectorAll('input[data-service]'))
            .filter(i => i.checked && !i.disabled)
            .map(i => i.dataset.service);
    }
    async onUpload() {
        const services = this.selectedServices();
        // remember the choice for next time
        this.querySelectorAll('input[data-service]').forEach(i => {
            if(!i.disabled) settings.setTarget(i.dataset.service, i.checked);
        });
        if(services.length === 0) { this.close(); return; }
        const btn = this.querySelector('[data-action=upload]');
        if(btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
        try {
            await analysis.saveAndUpload(this.activityId, services);
        } catch(e) {
            console.error(':analysis :upload', e);
        }
        await this.refresh();
    }
    async onCoach() {
        if(this.busy) return;
        this.busy = true;
        this.coachError = '';
        const notes = this.querySelector('#an-notes')?.value ?? '';
        const btn = this.querySelector('[data-action=coach]');
        if(btn) { btn.disabled = true; btn.textContent = 'Asking coach…'; }
        try {
            await analysis.requestCoachFeedback(this.activityId, {notes});
        } catch(e) {
            this.coachError = e.message ?? String(e);
        }
        this.busy = false;
        await this.refresh();
    }
    render() {
        const r = this.report;
        if(!r) {
            this.innerHTML = `<div class="an-sheet"><div class="an-head"><h2>Activity not found</h2>
                <button class="an-btn" data-action="close" aria-label="Close">✕</button></div></div>`;
            return;
        }
        const date = r.meta?.timestamp ? new Date(r.meta.timestamp).toLocaleString() : '';
        this.innerHTML = `
            <div class="an-sheet" role="dialog" aria-modal="true" aria-label="Ride report">
                <div class="an-head">
                    <h2>${esc(r.meta?.name ?? 'Ride')}</h2>
                    <button class="an-btn" data-action="close" aria-label="Close">✕</button>
                </div>
                <div class="an-sub">${esc(date)}${this.fresh ? ' · saved on this device' : ''}</div>
                ${this.renderSummary(r.summary)}
                ${this.renderUpload(r)}
                ${this.renderGarmin()}
                ${this.renderCoach(r)}
            </div>`;
    }
    renderSummary(s) {
        if(!s) {
            return `<div class="an-section an-note">No analysis data for this activity
                (it was recorded before ride analysis was available). Upload and FIT export still work.</div>`;
        }
        const hr = s.heartRate;
        const dec = hr?.decoupling;
        const c = s.compliance;
        return `
            <div class="an-section">
                <div class="an-tiles">
                    ${tile('Time', fmtDuration(s.durationSec))}
                    ${tile('Avg power', v(s.power.avg, ' W'))}
                    ${tile('NP', v(s.power.normalized, ' W'))}
                    ${tile('IF', v(s.power.intensityFactor))}
                    ${tile('TSS', v(s.power.tss))}
                    ${tile('Work', v(s.power.workKj, ' kJ'))}
                    ${tile('Avg / max HR', hr ? `${hr.avg} / ${hr.max}` : '--')}
                    ${tile('Pw:HR drift', dec?.decouplingPct !== undefined && dec?.decouplingPct !== null ? `${dec.decouplingPct}%` : '--')}
                    ${tile('Cadence', v(s.cadence?.avg, ' rpm'))}
                    ${c?.score !== null && c?.score !== undefined ? tile('Compliance', `${c.score}%`) : ''}
                </div>
                ${s.ftp ? '' : '<p class="an-note">Set your FTP to get IF, TSS and power zones.</p>'}
            </div>
            ${c ? this.renderCompliance(c) : ''}
            ${s.zones.power ? `<div class="an-section"><h3>Time in power zones</h3>${zoneBars(s.zones.power)}</div>` : ''}
            ${s.zones.heartRate ? `<div class="an-section"><h3>Time in HR zones</h3>${zoneBars(s.zones.heartRate)}</div>` : ''}
        `;
    }
    renderCompliance(c) {
        const rows = c.intervals.map(i => `
            <tr>
                <td>${i.index + 1}</td>
                <td>${fmtDuration(i.plannedSec)} / ${fmtDuration(i.actualSec)}</td>
                <td>${v(i.targetPower)}</td>
                <td>${v(i.avgPower)}</td>
                <td>${v(i.avgHr)}</td>
                <td><span class="an-status ${esc(i.status)}">${i.compliancePct !== null ? `${i.compliancePct}%` : statusLabel(i.status)}</span></td>
            </tr>`).join('');
        return `
            <div class="an-section">
                <h3>Intervals · ${c.intervalsOnTarget}/${c.intervalsWithTarget} on target (±${c.tolerancePct}%)</h3>
                <div style="overflow-x:auto">
                <table class="an-table">
                    <thead><tr><th>#</th><th>Plan / done</th><th>Target W</th><th>Avg W</th><th>HR</th><th></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
                </div>
                ${c.completedIntervals < c.plannedIntervals ?
                    `<p class="an-note">Completed ${c.completedIntervals} of ${c.plannedIntervals} planned intervals.</p>` : ''}
            </div>`;
    }
    renderUpload(r) {
        const targets = settings.getTargets();
        const jobs = Object.fromEntries((r.uploads ?? []).map(j => [j.service, j]));
        const rows = analysis.SERVICES.map(service => {
            const st = analysis.serviceState(service);
            const job = jobs[service];
            if(!st.available && !job && service === 'trainingPeaks') return '';
            const checked = st.available && (targets[service] || (job && job.status !== 'done'));
            const route = st.available ? `via ${ROUTE_LABELS[st.route] ?? st.route}` : 'not set up';
            const jobInfo = job ? `
                <span class="an-status ${esc(job.status)}">${esc(statusLabel(job.status))}</span>
                ${job.remote?.url ? `<a class="an-note" href="${esc(job.remote.url)}" target="_blank" rel="noopener">open</a>` : ''}
                ${['failed', 'pending', 'needs-setup'].includes(job.status) ?
                    `<button class="an-btn small" data-action="retry" data-job="${esc(job.id)}">Retry</button>` : ''}
                ${job.lastError ? `<span class="an-note">${esc(job.lastError)}</span>` : ''}` : '';
            return `
                <div class="an-row">
                    <label class="an-toggle">
                        <input type="checkbox" data-service="${service}" ${checked ? 'checked' : ''} ${st.available ? '' : 'disabled'}>
                        <span>${esc(SERVICE_LABELS[service])}</span>
                        <span class="route">${esc(route)}</span>
                    </label>
                    ${jobInfo}
                </div>`;
        }).join('');
        const privacy = analysis.serviceState('strava').route === 'auuki' ?
            '<p class="an-note">Strava uploads use your default Strava privacy setting. For muted uploads, connect your own Strava app in Settings.</p>' :
            '<p class="an-note">Strava has no API option for “Only You” uploads. Uploads use your default Strava privacy, and are muted from feeds if you turned that on in Settings.</p>';
        return `
            <div class="an-section">
                <h3>Save &amp; upload</h3>
                ${rows}
                ${privacy}
                <div class="an-row" style="margin-top:0.5em">
                    <button class="an-btn primary" data-action="upload">Save &amp; upload</button>
                    <button class="an-btn" data-action="settings">Upload settings</button>
                </div>
                <p class="an-note">The ride is already saved on this device. Failed uploads are queued and retried automatically when you're back online.</p>
            </div>`;
    }
    renderGarmin() {
        const share = analysis.canShareFiles();
        return `
            <div class="an-section">
                <h3>Garmin Connect &amp; FIT file</h3>
                <div class="an-row">
                    ${share ? '<button class="an-btn" data-action="share">Share / Save FIT…</button>' : ''}
                    <button class="an-btn" data-action="download">Download FIT</button>
                    <a class="an-btn" style="display:inline-flex;align-items:center;text-decoration:none"
                       href="${GARMIN_IMPORT_URL}" target="_blank" rel="noopener">Open Garmin import</a>
                </div>
                <details class="an-details an-note">
                    <summary>How to get this ride into Garmin Connect</summary>
                    <ol>
                        <li>Tap <b>${share ? 'Share / Save FIT… → Save to Files' : 'Download FIT'}</b>.</li>
                        <li>Open <b>Open Garmin import</b> (connect.garmin.com → Import Data) in the browser and sign in.</li>
                        <li>Choose the <code>.fit</code> file and tap <b>Import Data</b>. The Garmin Connect mobile app cannot import files.</li>
                    </ol>
                    Garmin has no upload API for individual apps. Strava and intervals.icu don't send uploaded rides on to Garmin either, so a manual import is the only way to get a non-Garmin ride into Garmin Connect.
                </details>
            </div>`;
    }
    renderCoach(r) {
        const fb = r.feedback;
        const configured = analysis.aiConfigured();
        let body = '';
        if(fb) {
            body = `
                <div class="an-feedback">
                    <div class="an-row"><div class="an-rating">${v(fb.rating)}<span style="font-size:0.4em">/10</span></div>
                    <div>${esc(fb.headline)}</div></div>
                    ${fb.text ? `<p>${esc(fb.text)}</p>` : ''}
                    ${fb.wentWell?.length ? `<b>What went well</b><ul>${fb.wentWell.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
                    ${fb.improve?.length ? `<b>What to improve</b><ul>${fb.improve.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
                    ${fb.adjustments?.length ? `<b>Adjustments to upcoming training</b><ul>${fb.adjustments.map(a =>
                        `<li>${a.when ? `<b>${esc(a.when)}:</b> ` : ''}${esc(a.suggestion)}</li>`).join('')}</ul>` : ''}
                    <div class="an-note">Saved with this activity · ${esc(new Date(fb.createdAt).toLocaleString())}</div>
                </div>
                ${configured ? `<x-ai-plan-changes data-activity-id="${esc(r.id)}"></x-ai-plan-changes>` : ''}`;
        }
        if(!configured) {
            return fb ? `<div class="an-section"><h3>Coach feedback</h3>${body}</div>` :
                `<div class="an-section"><h3>Coach feedback</h3>
                 <p class="an-note">Add an Anthropic API key in the AI settings to get feedback on this ride.</p></div>`;
        }
        if(!r.summary) return '';
        return `
            <div class="an-section">
                <h3>Coach feedback</h3>
                ${body}
                <div class="an-field">
                    <label for="an-notes">How did it feel? (optional)</label>
                    <textarea id="an-notes" class="an-textarea" rows="2" placeholder="e.g. legs heavy, slept badly"></textarea>
                </div>
                <button class="an-btn primary" data-action="coach">${fb ? 'Ask again' : 'Coach feedback'}</button>
                ${this.coachError ? `<p class="an-error">${esc(this.coachError)}</p>` : ''}
                <p class="an-note">Sends this ride's summary, the planned workout and your upcoming plan to Claude.</p>
            </div>`;
    }
}

customElements.define('x-analysis-report', AnalysisReport);

// --- dock panel --------------------------------------------------------------

class AnalysisPanel extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.classList.add('an-panel');
        xf.sub('analysis:upload', () => this.render(), signal);
        xf.sub('analysis:changed', () => this.render(), signal);
        xf.sub('activity:restore', () => this.render(), signal);
        this.addEventListener('click', async (e) => {
            const el = e.target.closest('[data-action]');
            if(!el) return;
            if(el.dataset.action === 'open') {
                const id = await analysis.latestActivityId();
                if(id) xf.dispatch('analysis:report:open', id);
            }
            if(el.dataset.action === 'retry-all') {
                const jobs = await analysis.queue.list();
                for(const j of jobs.filter(j => j.status !== 'done')) await analysis.queue.retry(j.id);
            }
        }, signal);
        this.render();
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    async render() {
        let jobs = [];
        let latest = null;
        try {
            jobs = await analysis.queue.list();
            const id = await analysis.latestActivityId();
            latest = id ? await analysis.getReport(id) : null;
        } catch(e) { /* idb not ready yet */ }
        const open = jobs.filter(j => j.status !== 'done');
        const s = latest?.summary;
        this.innerHTML = `
            <div class="an-note">Last ride</div>
            <div style="font-weight:700">${esc(latest?.meta?.name ?? 'No rides yet')}</div>
            ${s ? `<div class="an-tiles" style="margin:0.5em 0">
                ${tile('Time', fmtDuration(s.durationSec))}
                ${tile('NP', v(s.power.normalized, ' W'))}
                ${tile('TSS', v(s.power.tss))}
            </div>` : ''}
            <div class="an-row">
                <button class="an-btn" data-action="open" ${latest ? '' : 'disabled'}>Ride report</button>
                ${open.length ? `<button class="an-btn" data-action="retry-all">Retry ${open.length} upload${open.length > 1 ? 's' : ''}</button>` : ''}
            </div>
            ${open.length ? `<p class="an-note">${open.length} upload${open.length > 1 ? 's' : ''} waiting${navigator.onLine === false ? ' (offline)' : ''}.</p>` : ''}
        `;
    }
}

customElements.define('x-analysis-panel', AnalysisPanel);

// --- settings ----------------------------------------------------------------

class AnalysisSettings extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = {signal: this.abortController.signal};
        this.message = '';
        xf.sub('analysis:settings', () => this.render(), signal);
        xf.sub('db:services', () => this.render(), signal);
        xf.sub('analysis:strava', (res) => {
            this.message = res.ok ? 'Strava connected.' : `Strava connection failed: ${res.error}`;
            this.render();
        }, signal);
        this.addEventListener('click', this.onClick.bind(this), signal);
        this.addEventListener('change', this.onChange.bind(this), signal);
        this.render();
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    val(id) {
        return (this.querySelector(`#${id}`)?.value ?? '').trim();
    }
    onChange(e) {
        const t = e.target;
        if(t.dataset.target) settings.setTarget(t.dataset.target, t.checked);
        if(t.id === 'an-auto-upload') settings.set(settings.Keys.autoUpload, t.checked ? 'true' : 'false');
        if(t.id === 'an-strava-hide') settings.set(settings.Keys.stravaHide, t.checked ? 'true' : 'false');
    }
    async onClick(e) {
        const el = e.target.closest('[data-action]');
        if(!el) return;
        const a = el.dataset.action;
        if(a === 'save-intervals') {
            settings.set(settings.Keys.intervalsAthleteId, this.val('an-icu-athlete'));
            settings.set(settings.Keys.intervalsApiKey, this.val('an-icu-key'));
            this.message = 'intervals.icu settings saved.';
            xf.dispatch('analysis:settings');
        }
        if(a === 'test-intervals') {
            await this.testIntervals();
        }
        if(a === 'save-strava') {
            settings.set(settings.Keys.stravaClientId, this.val('an-strava-id'));
            settings.set(settings.Keys.stravaClientSecret, this.val('an-strava-secret'));
            this.message = 'Strava app saved. Tap Connect to authorize.';
            xf.dispatch('analysis:settings');
        }
        if(a === 'connect-strava') {
            settings.set(settings.Keys.stravaClientId, this.val('an-strava-id'));
            settings.set(settings.Keys.stravaClientSecret, this.val('an-strava-secret'));
            analysis.connectStravaDirect();
        }
        if(a === 'disconnect-strava') {
            analysis.disconnectStravaDirect();
            this.message = 'Strava app disconnected on this device.';
        }
        if(a === 'save-hr') {
            settings.set(settings.Keys.maxHr, this.val('an-max-hr'));
            settings.set(settings.Keys.lthr, this.val('an-lthr'));
            this.message = 'Heart-rate settings saved.';
        }
        this.render();
    }
    async testIntervals() {
        const athlete = this.val('an-icu-athlete') || '0';
        const key = this.val('an-icu-key');
        if(!key) { this.message = 'Enter your API key first.'; return; }
        try {
            const res = await fetch(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(athlete)}`, {
                headers: {Authorization: 'Basic ' + btoa(`API_KEY:${key}`)},
            });
            if(res.ok) {
                const body = await res.json();
                this.message = `intervals.icu OK: ${body.name ?? body.id ?? 'athlete found'}.`;
            } else {
                this.message = `intervals.icu test failed (${res.status}). Check the athlete ID and API key.`;
            }
        } catch(e) {
            this.message = 'intervals.icu test failed (network).';
        }
    }
    render() {
        const targets = settings.getTargets();
        const icu = settings.intervalsDirect();
        const strava = settings.stravaDirect();
        const athlete = settings.athlete();
        const redirectHost = typeof window !== 'undefined' ? window.location.hostname : '';
        const toggles = analysis.SERVICES.map(service => {
            const st = analysis.serviceState(service);
            return `<label class="an-toggle">
                <input type="checkbox" data-target="${service}" ${targets[service] ? 'checked' : ''}>
                <span>${esc(SERVICE_LABELS[service])}</span>
                <span class="route">${st.available ? `via ${esc(ROUTE_LABELS[st.route])}` : 'not set up'}</span>
            </label>`;
        }).join('');

        this.innerHTML = `
            <h2 class="page--heading">Ride export &amp; analysis</h2>
            ${this.message ? `<p class="an-note">${esc(this.message)}</p>` : ''}

            <div class="an-card">
                <h3>After a ride</h3>
                ${toggles}
                <label class="an-toggle">
                    <input type="checkbox" id="an-auto-upload" ${settings.getBool(settings.Keys.autoUpload) ? 'checked' : ''}>
                    <span>Upload automatically when I stop the ride</span>
                </label>
                <p class="an-note">Uploads that fail (offline, service down) are kept on this device and retried automatically.</p>
            </div>

            <div class="an-card">
                <h3>intervals.icu (API key)</h3>
                <p class="an-note">Works without an Auuki account. You can find your athlete ID and API key at the bottom of
                    <a href="https://intervals.icu/settings" target="_blank" rel="noopener">intervals.icu → Settings → Developer Settings</a>.
                    They're stored only in this browser.</p>
                <div class="an-field"><label for="an-icu-athlete">Athlete ID (e.g. i12345)</label>
                    <input id="an-icu-athlete" class="an-input" autocomplete="off" value="${esc(icu.athleteId === '0' ? '' : icu.athleteId)}"></div>
                <div class="an-field"><label for="an-icu-key">API key</label>
                    <input id="an-icu-key" class="an-input" type="password" autocomplete="off" value="${esc(icu.apiKey)}"></div>
                <div class="an-row">
                    <button class="an-btn primary" data-action="save-intervals">Save</button>
                    <button class="an-btn" data-action="test-intervals">Test</button>
                </div>
            </div>

            <div class="an-card">
                <h3>Strava (your own API app)</h3>
                <p class="an-note">Optional. Without it, Strava uploads go through your Auuki account.
                    With your own app, uploads are marked as trainer rides and can be muted from feeds.
                    <b>Strava's API cannot make an activity private.</b> Uploads use the default visibility in your
                    Strava privacy settings, so set that to “Only You” if you want new rides private.</p>
                <details class="an-details an-note"><summary>Set up a Strava API app</summary>
                    <ol>
                        <li>Go to <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a> and create an app.</li>
                        <li>Set <b>Authorization Callback Domain</b> to <code>${esc(redirectHost)}</code>.</li>
                        <li>Copy the Client ID and Client Secret here, then tap Connect.</li>
                    </ol>
                    The secret is stored only in this browser.
                </details>
                <div class="an-field"><label for="an-strava-id">Client ID</label>
                    <input id="an-strava-id" class="an-input" inputmode="numeric" autocomplete="off" value="${esc(strava.clientId)}"></div>
                <div class="an-field"><label for="an-strava-secret">Client Secret</label>
                    <input id="an-strava-secret" class="an-input" type="password" autocomplete="off" value="${esc(strava.clientSecret)}"></div>
                <label class="an-toggle">
                    <input type="checkbox" id="an-strava-hide" ${strava.hideFromHome ? 'checked' : ''}>
                    <span>Mute uploads from Home &amp; club feeds</span>
                </label>
                <div class="an-row">
                    <button class="an-btn" data-action="save-strava">Save</button>
                    ${strava.configured ?
                        '<button class="an-btn" data-action="disconnect-strava">Disconnect</button><span class="an-note">Connected</span>' :
                        '<button class="an-btn primary" data-action="connect-strava">Connect</button>'}
                </div>
            </div>

            <div class="an-card">
                <h3>Heart-rate zones</h3>
                <p class="an-note">Used for time in HR zones. LTHR is used if set, otherwise max HR.</p>
                <div class="an-row">
                    <div class="an-field" style="flex:1"><label for="an-max-hr">Max HR</label>
                        <input id="an-max-hr" class="an-input" inputmode="numeric" value="${esc(athlete.maxHr ?? '')}"></div>
                    <div class="an-field" style="flex:1"><label for="an-lthr">LTHR</label>
                        <input id="an-lthr" class="an-input" inputmode="numeric" value="${esc(athlete.lthr ?? '')}"></div>
                </div>
                <button class="an-btn" data-action="save-hr">Save</button>
            </div>

            <div class="an-card">
                <h3>Garmin Connect</h3>
                <p class="an-note">Garmin only offers its upload API to approved business partners, so Auuki can't upload for you.
                    After a ride, use <b>Share / Download FIT</b> in the ride report, then import the file at
                    <a href="${GARMIN_IMPORT_URL}" target="_blank" rel="noopener">connect.garmin.com → Import Data</a>.
                    Strava and intervals.icu don't forward uploaded rides to Garmin.</p>
            </div>
        `;
    }
}

customElements.define('x-analysis-settings', AnalysisSettings);

// --- mount -------------------------------------------------------------------

function mount() {
    injectStyles();
    if(!document.querySelector('x-analysis-report')) {
        document.body.appendChild(document.createElement('x-analysis-report'));
    }
    // fallback mount point for the settings element if index.html has no section yet
    const section = document.getElementById('analysis-settings');
    if(section && !section.querySelector('x-analysis-settings')) {
        section.appendChild(document.createElement('x-analysis-settings'));
    }
    registerPanel({
        id: 'analysis',
        title: 'Ride report',
        icon: 'chart',
        element: document.createElement('x-analysis-panel'),
    });
}

export { mount, AnalysisReport, AnalysisPanel, AnalysisSettings };
