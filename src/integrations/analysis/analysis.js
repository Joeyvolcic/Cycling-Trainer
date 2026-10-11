//
// Post-ride analysis & export service: wires the summary, upload queue and coach
// feedback into the app via the `xf` bus. Views live in ./views.js.
//
// Events dispatched:
//   'analysis:report'  {id}           a fresh report is ready (after a ride is saved)
//   'analysis:upload'  UploadJob      a queue job changed (without the blob)
//   'analysis:changed' {id}           stored analysis for an activity changed (e.g. feedback)
//
// Events consumed (besides the app's activity:add / workout:started):
//   'quiz:ride-summary' {reviewed, correct, start, end}  stored as record.analysis.quiz
//

import { xf } from '../../functions.js';
import { idb } from '../../storage/idb.js';
import { models } from '../../models/models.js';
import config from '../../models/config.js';
import { fileHandler } from '../../file.js';
import { summarizeActivity, toStreams } from './summary.js';
import { UploadStore } from './store.js';
import { UploadQueue, Status } from './queue.js';
import { Uploaders, SERVICES } from './uploaders.js';
import { requestFeedback } from './coach.js';
import * as settings from './settings.js';
import * as claude from '../ai/claude.js';

const STRAVA_STATE_PREFIX = 'analysisStrava_';
const ACTIVITY_STORE = 'activity';

// mirrors db.services (upstream backend connections)
const backend = {strava: false, intervals: false, trainingPeaks: false};

const uploaders = Uploaders({
    isConnected: (service) => !!(backend[service] ?? (service === 'trainingPeaks' ? backend.tp : false)),
    apiUri: () => config.get().API_URI,
});

const queue = UploadQueue({
    store: UploadStore(),
    uploaders,
    onChange: onJobChange,
});

// existing activity-list indicators use these names
const indicatorName = {strava: 'strava', intervals: 'intervals', trainingPeaks: 'tp'};

function publicJob(job) {
    const {blob, ...rest} = job;
    return rest;
}

async function onJobChange(job) {
    xf.dispatch('analysis:upload', publicJob(job));

    const state = job.status === Status.done ? 'success' :
                  job.status === Status.uploading ? 'loading' :
                  job.status === Status.pending && job.attempts === 0 ? 'loading' :
                  'fail';
    const name = indicatorName[job.service];
    if(name) {
        xf.dispatch(`action:activity:${job.activityId}`, `:${name}:upload:${state}`);
    }
    if(state === 'loading') return;
    try {
        const record = await idb.get(ACTIVITY_STORE, job.activityId);
        if(record?.summary) {
            record.summary.status = Object.assign({}, record.summary.status, {[job.service]: state});
            await idb.put(ACTIVITY_STORE, record);
        }
    } catch(e) {
        console.warn(':analysis :status', e);
    }
}

//
// Capture analysis data when the app saves an activity (watch:stopped -> activity:add).
// At this point db.records/laps are still intact (session reset happens right after).
//
function workoutLapOffset(laps = [], startedAt) {
    if(!startedAt) return 0;
    return laps.filter(l => (l.timestamp ?? 0) <= startedAt).length;
}

function compactWorkout(workout) {
    if(!workout || !Array.isArray(workout.intervals)) return null;
    return {
        meta: {name: workout.meta?.name ?? null, description: workout.meta?.description ?? null},
        intervals: workout.intervals,
    };
}

function capture(summary, db) {
    const session = settings.getJSON(settings.Keys.workoutSession, null);
    settings.set(settings.Keys.workoutSession, '');

    const records = db.records ?? [];
    const firstTs = records.find(r => typeof r.timestamp === 'number')?.timestamp ?? 0;
    // a workout session flag from an older ride is ignored
    const startedAt = session && session.startedAt >= firstTs - 60000 ? session.startedAt : null;
    const followedWorkout = !!startedAt;

    const input = {
        id: summary.id,
        name: summary.name,
        timestamp: summary.timestamp,
        streams: toStreams({records}),
        laps: (db.laps ?? []).map(l => ({start_time: l.start_time, timestamp: l.timestamp})),
        workout: followedWorkout ? compactWorkout(db.workout) : null,
        workoutLapOffset: followedWorkout ? workoutLapOffset(db.laps, startedAt) : 0,
        ftp: db.ftp,
    };
    return input;
}

function summarize(input) {
    return summarizeActivity(input, settings.athlete());
}

// serialize read-modify-write of activity records (quiz summary vs. save can race)
let persistChain = Promise.resolve();

function persistAnalysis(id, patch) {
    const run = () => persistAnalysisNow(id, patch);
    persistChain = persistChain.then(run, run);
    return persistChain;
}

async function persistAnalysisNow(id, patch) {
    const record = await idb.get(ACTIVITY_STORE, id);
    if(!record || !record.summary) return null;
    record.analysis = Object.assign({}, record.analysis ?? {}, patch);
    await idb.put(ACTIVITY_STORE, record);
    xf.dispatch('analysis:changed', {id});
    return record;
}

//
// Quiz ride summary -> record.analysis.quiz
//
// The quiz dispatches 'quiz:ride-summary' on db:watchStatus 'stopped', which can
// arrive before or after activity:add depending on listener order, so keep the
// latest summary briefly and attach it from whichever side comes second.
//
const QUIZ_MATCH_WINDOW = 2 * 60 * 1000;
let pendingQuiz = null;  // {summary, at}
let lastSaved = null;    // {id, at}

function quizFromSummary(x) {
    if(!x || typeof x !== 'object') return null;
    const reviewed = Number(x.reviewed) || 0;
    if(reviewed <= 0) return null;
    return {
        reviewed,
        correct: Number(x.correct) || 0,
        start: x.start ?? null,
        end: x.end ?? null,
    };
}

function takePendingQuiz(now = Date.now()) {
    const p = pendingQuiz;
    pendingQuiz = null;
    if(!p || now - p.at > QUIZ_MATCH_WINDOW) return null;
    return p.summary;
}

function onQuizSummary(x, now = Date.now()) {
    const quiz = quizFromSummary(x);
    if(!quiz) return Promise.resolve(null);
    if(lastSaved && Math.abs(now - lastSaved.at) <= QUIZ_MATCH_WINDOW) {
        const id = lastSaved.id;
        lastSaved = null;
        return persistAnalysis(id, {quiz});
    }
    pendingQuiz = {summary: quiz, at: now};
    return Promise.resolve(null);
}

async function onActivitySaved(summary, db) {
    let input;
    try {
        input = capture(summary, db);
    } catch(e) {
        console.error(':analysis :capture', e);
        return;
    }
    const result = summarize(input);
    const quiz = takePendingQuiz();
    lastSaved = quiz ? null : {id: summary.id, at: Date.now()};
    await persistAnalysis(summary.id, {
        version: 1,
        input,
        summary: result,
        feedback: null,
        quiz,
        createdAt: Date.now(),
    });

    xf.dispatch('analysis:report', {id: summary.id, fresh: true});

    if(settings.getBool(settings.Keys.autoUpload, false)) {
        const targets = settings.getTargets();
        const services = SERVICES.filter(s => targets[s] && uploaders.resolve(s));
        if(services.length) await saveAndUpload(summary.id, services);
    }
}

//
// Public API used by views
//
async function getRecord(id) {
    return idb.get(ACTIVITY_STORE, id);
}

async function getReport(id) {
    const record = await getRecord(id);
    if(!record) return null;
    let summary = record.analysis?.summary ?? null;
    // recompute with the current athlete settings (HR zones may have been set since)
    if(record.analysis?.input) {
        try { summary = summarize(record.analysis.input); } catch(e) { /* keep stored */ }
    }
    return {
        id,
        meta: record.summary,
        summary,
        input: record.analysis?.input ?? null,
        feedback: record.analysis?.feedback ?? null,
        quiz: record.analysis?.quiz ?? null,
        uploads: (await queue.forActivity(id)).map(publicJob),
    };
}

async function latestActivityId() {
    const records = (await idb.getAll(ACTIVITY_STORE)) ?? [];
    const latest = records
        .filter(r => r?.summary)
        .sort((a, b) => b.summary.timestamp - a.summary.timestamp)[0];
    return latest?.id ?? null;
}

function serviceState(service) {
    const adapter = uploaders.resolve(service);
    return {
        service,
        available: !!adapter,
        route: adapter?.route ?? null,
    };
}

async function saveAndUpload(id, services = [], {force = false} = {}) {
    const record = await getRecord(id);
    if(!record?.blob) throw new Error('Activity file not found');
    for(const service of services) {
        await queue.enqueue({
            activityId: id,
            service,
            name: record.summary?.name,
            blob: record.blob,
            timestamp: record.summary?.timestamp,
        }, {force});
    }
    return queue.process();
}

// single-service upload from the activity list buttons
async function onUploadRequest({id, service}) {
    await saveAndUpload(id, [service], {force: true});
    const job = (await queue.forActivity(id)).find(j => j.service === service);
    if(job && job.status === Status.needsSetup) {
        // show the report so the user sees why and where to set it up
        xf.dispatch('analysis:report:open', id);
    }
}

function fitFileName(record) {
    const d = new Date(record.summary?.timestamp ?? Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `auuki-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.fit`;
}

async function downloadFit(id) {
    const record = await getRecord(id);
    if(!record?.blob) return false;
    fileHandler.download()(record.blob, fitFileName(record), fileHandler.Type.OctetStream);
    return true;
}

function canShareFiles() {
    try {
        const probe = new File([new Uint8Array(1)], 'probe.fit', {type: 'application/octet-stream'});
        return !!(navigator.canShare && navigator.canShare({files: [probe]}));
    } catch(e) {
        return false;
    }
}

// iPad: opens the share sheet ("Save to Files", AirDrop, mail...)
async function shareFit(id) {
    const record = await getRecord(id);
    if(!record?.blob) return false;
    const file = new File([record.blob], fitFileName(record), {type: 'application/octet-stream'});
    if(navigator.canShare && navigator.canShare({files: [file]})) {
        try {
            await navigator.share({files: [file], title: record.summary?.name ?? 'Ride'});
            return true;
        } catch(e) {
            if(e?.name === 'AbortError') return true;
        }
    }
    return downloadFit(id);
}

function isoDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Optional context from the training plan store (src/integrations/plans), if present.
// Reads the shared IDB store directly so this module does not depend on the plans branch.
async function getPlanContext(date = new Date()) {
    try {
        const plans = await idb.getAll('plans');
        if(!Array.isArray(plans) || plans.length === 0) return null;
        const from = new Date(date); from.setDate(from.getDate() - 7);
        const to = new Date(date); to.setDate(to.getDate() + 14);
        const lo = isoDate(from), hi = isoDate(to), today = isoDate(date);
        const entries = [];
        for(const plan of plans) {
            for(const e of plan.entries ?? []) {
                if(e.date >= lo && e.date <= hi) {
                    entries.push({
                        plan: plan.name, date: e.date, workoutName: e.workoutName,
                        durationMin: e.durationMin ?? null, status: e.status, notes: e.notes ?? '',
                    });
                }
            }
        }
        if(entries.length === 0) return null;
        entries.sort((a, b) => a.date.localeCompare(b.date));
        return {
            today,
            goals: plans.map(p => p.goal).filter(Boolean),
            recent: entries.filter(e => e.date < today),
            upcoming: entries.filter(e => e.date >= today),
        };
    } catch(e) {
        return null;
    }
}

function aiConfigured() {
    try { return claude.isConfigured(); } catch(e) { return false; }
}

async function requestCoachFeedback(id, {notes = ''} = {}) {
    const report = await getReport(id);
    if(!report?.summary) throw new Error('No analysis data for this activity');
    const planContext = await getPlanContext(new Date(report.meta?.timestamp ?? Date.now()));
    const feedback = await requestFeedback(claude, {
        summary: report.summary,
        workout: report.input?.workout ?? null,
        planContext,
        athlete: settings.athlete(),
        notes,
    });
    await persistAnalysis(id, {feedback});
    return feedback;
}

//
// Strava "own app" OAuth (client-side; tokens stay in this browser)
//
function connectStravaDirect() {
    const state = STRAVA_STATE_PREFIX + Math.random().toString(36).slice(2);
    sessionStorage.setItem('analysis:strava-state', state);
    const redirect = window.location.origin + window.location.pathname;
    window.location.assign(uploaders.stravaDirect.authorizeUrl(redirect, state));
}

function disconnectStravaDirect() {
    [settings.Keys.stravaRefreshToken, settings.Keys.stravaAccessToken,
     settings.Keys.stravaExpiresAt, settings.Keys.stravaScope].forEach(k => settings.set(k, ''));
    xf.dispatch('analysis:settings');
}

async function handleStravaCallback() {
    const params = new URL(window.location.href).searchParams;
    const state = params.get('state') ?? '';
    if(!state.startsWith(STRAVA_STATE_PREFIX)) return;
    const expected = sessionStorage.getItem('analysis:strava-state');
    sessionStorage.removeItem('analysis:strava-state');
    window.history.replaceState({}, document.title, window.location.pathname);

    if(params.get('error') || state !== expected) {
        xf.dispatch('analysis:strava', {ok: false, error: params.get('error') ?? 'state mismatch'});
        return;
    }
    try {
        await uploaders.stravaDirect.exchangeCode(params.get('code'), params.get('scope') ?? '');
        xf.dispatch('analysis:strava', {ok: true, scope: params.get('scope') ?? ''});
        xf.dispatch('analysis:settings');
        queue.process();
    } catch(e) {
        xf.dispatch('analysis:strava', {ok: false, error: e.message});
    }
}

//
// Wiring
//
let started = false;

function start() {
    if(started) return;
    started = true;

    // xf.reg handlers receive the app db as 2nd argument
    xf.reg('activity:add', (summary, db) => {
        onActivitySaved(summary, db).catch(e => console.error(':analysis :save', e));
    });
    xf.reg('workout:started', (_, db) => {
        const existing = settings.getJSON(settings.Keys.workoutSession, null);
        const firstTs = (db.records ?? []).find(r => typeof r.timestamp === 'number')?.timestamp;
        // keep the original start when a running workout is restored after a reload
        if(existing && firstTs && existing.startedAt >= firstTs - 60000) return;
        settings.setJSON(settings.Keys.workoutSession, {startedAt: Date.now()});
    });
    xf.sub('db:services', (services) => {
        Object.assign(backend, services ?? {});
        queue.process();
    });
    xf.sub('activity:restore', () => {
        // idb is open now
        queue.process();
    });
    xf.sub('analysis:settings', () => queue.process());
    xf.sub('quiz:ride-summary', (x) => {
        onQuizSummary(x).catch(e => console.error(':analysis :quiz', e));
    });
    xf.sub('analysis:upload:request', (req) => {
        onUploadRequest(req).catch(e => console.error(':analysis :upload', e));
    });

    window.addEventListener('online', () => queue.process());
    document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible') queue.process();
    });
    setInterval(() => { if(navigator.onLine !== false) queue.process(); }, 5 * 60 * 1000);

    handleStravaCallback();
}

export {
    start,
    onActivitySaved,
    onQuizSummary,
    queue,
    uploaders,
    getReport,
    latestActivityId,
    serviceState,
    saveAndUpload,
    downloadFit,
    shareFit,
    canShareFiles,
    requestCoachFeedback,
    aiConfigured,
    getPlanContext,
    connectStravaDirect,
    disconnectStravaDirect,
    SERVICES,
};
