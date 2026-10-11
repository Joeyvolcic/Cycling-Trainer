//
// Ride-aware media: intensity playlists + auto-pause of spoken content.
//
// Listens on xf:
//   db:workout, db:ftp           -> recompute segment plan
//   db:intervalIndex             -> switch playlist when the segment type changes
//   workout:started              -> apply the first segment
//   watch:paused / watch:started -> auto-pause / resume podcasts & audiobooks
//   watch:stopped                -> reset
// Dispatches 'media:segment' {index, type, playlist, decision}
//

import { xf } from '../../functions.js';
import * as auth from './spotify-auth.js';
import * as session from './session.js';
import { localPlayer } from './local-player.js';
import { planSegments, switchDecision, shouldAutoPause, playlistFor } from './intensity.js';
import { KEYS, lsGetJSON, lsSetJSON, getPrefs } from './store.js';

const DEFAULT_INTENSITY = {enabled: false, mapping: {}};

function getIntensity() {
    return Object.assign({}, DEFAULT_INTENSITY, lsGetJSON(KEYS.intensity, {}));
}

function setIntensity(patch = {}) {
    const next = Object.assign(getIntensity(), patch);
    lsSetJSON(KEYS.intensity, next);
    xf.dispatch('media:intensity', next);
    return next;
}

const ride = {
    workout:       null,
    ftp:           null,
    plan:          [],
    index:         -1,
    lastType:      null,
    lastApplied:   '',
    workoutActive: false,
    pausedByUs:    {spotify: false, local: false},
    segment:       null,
};

function replan() {
    const intervals = ride.workout?.intervals || [];
    ride.plan = planSegments(intervals, ride.ftp);
    xf.dispatch('media:plan', ride.plan.slice());
}

async function applySegment(index, {force = false} = {}) {
    const type = ride.plan[index] ?? null;
    const intensity = getIntensity();
    const playlist = playlistFor(intensity.mapping, type);
    ride.segment = {index, type, playlist};

    if(!force && type === ride.lastType) {
        xf.dispatch('media:segment', Object.assign({decision: {action: 'none', reason: 'same-type'}}, ride.segment));
        return;
    }
    ride.lastType = type;

    let decision = {action: 'none', reason: 'not-connected'};
    if(auth.isLoggedIn()) {
        const np = session.state.np;
        decision = switchDecision({
            enabled: intensity.enabled,
            type,
            mapping: intensity.mapping,
            currentContextUri: np.isPlaying ? np.contextUri : '',
            lastAppliedUri: ride.lastApplied,
            spokenPlaying: np.isPlaying && np.spoken,
        });
        if(decision.action === 'switch') {
            ride.lastApplied = decision.uri;
            await session.playItem({contextUri: decision.uri});
        }
    }
    xf.dispatch('media:segment', Object.assign({decision}, ride.segment));
}

async function onPause() {
    if(!getPrefs().autoPauseSpoken) return;
    const lp = localPlayer();
    if(lp.isPlaying()) {
        lp.pause();
        ride.pausedByUs.local = true;
    }
    if(auth.isLoggedIn()) {
        await session.refresh();
        const np = session.state.np;
        if(shouldAutoPause({enabled: true, isPlaying: np.isPlaying, spoken: np.spoken})) {
            await session.pause();
            ride.pausedByUs.spotify = true;
        }
    }
}

async function onResume() {
    const resume = getPrefs().autoResume;
    if(ride.pausedByUs.local) {
        ride.pausedByUs.local = false;
        if(resume) localPlayer().play();
    }
    if(ride.pausedByUs.spotify) {
        ride.pausedByUs.spotify = false;
        if(resume) await session.resume();
    }
}

function start() {
    xf.sub('db:workout', workout => { ride.workout = workout; replan(); });
    xf.sub('db:ftp',     ftp     => { ride.ftp = ftp; replan(); });
    xf.sub('db:intervalIndex', index => {
        if(index === ride.index) return;
        ride.index = index;
        if(ride.workoutActive) applySegment(index);
    });
    xf.sub('workout:started', () => {
        ride.workoutActive = true;
        ride.lastType = null;
        ride.lastApplied = '';
        replan();
        ride.index = 0;
        applySegment(0, {force: true});
    });
    xf.sub('workout:stopped', () => { ride.workoutActive = false; ride.lastType = null; });
    xf.sub('workout:done',    () => { ride.workoutActive = false; });
    xf.sub('watch:paused',  () => { onPause(); });
    xf.sub('watch:started', () => { onResume(); });
    xf.sub('watch:stopped', () => {
        ride.pausedByUs = {spotify: false, local: false};
        ride.workoutActive = false;
    });
}

function current() { return ride.segment; }
function getPlan() { return ride.plan.slice(); }

export { start, getIntensity, setIntensity, current, getPlan, applySegment };
