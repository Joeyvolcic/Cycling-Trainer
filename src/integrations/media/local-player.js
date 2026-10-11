//
// Local / non-Spotify audio: RSS podcast episodes and local audio files (audiobooks),
// played through a single <audio> element. Resume positions persist in IndexedDB.
//

import { xf } from '../../functions.js';
import { getPosition, savePosition } from './store.js';

const SAVE_EVERY_MS = 5000;

function LocalPlayer() {
    const audio = new Audio();
    audio.preload = 'metadata';
    // iOS: keep playing inline, not fullscreen
    audio.setAttribute('playsinline', '');

    let current   = null;   // {id, title, subtitle, art, url, kind: 'episode'|'file'}
    let objectUrl = null;
    let lastSave  = 0;

    function state() {
        return {
            source:     'local',
            active:     !!current,
            isPlaying:  !!current && !audio.paused && !audio.ended,
            title:      current?.title || '',
            subtitle:   current?.subtitle || '',
            art:        current?.art || '',
            progressMs: Math.round((audio.currentTime || 0) * 1000),
            durationMs: isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0,
            spoken:     true,
            rate:       audio.playbackRate,
            fetchedAt:  Date.now(),
            id:         current?.id || '',
        };
    }

    function emit() { xf.dispatch('media:local', state()); }

    async function persist(force = false) {
        if(!current) return;
        const now = Date.now();
        if(!force && now - lastSave < SAVE_EVERY_MS) return;
        lastSave = now;
        const duration = isFinite(audio.duration) ? audio.duration : 0;
        // finished -> restart next time
        const position = (duration && audio.currentTime > duration - 5) ? 0 : audio.currentTime;
        await savePosition({id: current.id, title: current.title, position, duration});
    }

    audio.addEventListener('timeupdate', () => { persist(); emit(); });
    audio.addEventListener('pause',      () => { persist(true); emit(); });
    audio.addEventListener('play',       emit);
    audio.addEventListener('ended',      () => { persist(true); emit(); });
    audio.addEventListener('loadedmetadata', emit);
    audio.addEventListener('error', () => {
        xf.dispatch('media:error', 'Could not play this audio (unsupported format or the URL is unreachable).');
        emit();
    });

    // item: {id, title, subtitle, art, url | file}
    async function load(item, {autoplay = true} = {}) {
        // positions are read synchronously inside persist(), no need to await
        // (awaiting here would lose the iOS user-gesture needed for play())
        persist(true);
        if(objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        let src = item.url;
        if(item.file) {
            objectUrl = URL.createObjectURL(item.file);
            src = objectUrl;
        }
        current = {id: item.id, title: item.title, subtitle: item.subtitle || '', art: item.art || '', kind: item.file ? 'file' : 'episode'};
        lastSave = Date.now(); // don't overwrite the saved position with 0 before we seek
        audio.src = src;
        setupMediaSession();
        const playing = autoplay ? play() : Promise.resolve();

        const saved = await getPosition(item.id);
        const resumeAt = saved && saved.position > 0 ? saved.position : 0;
        if(resumeAt > 0 && current && current.id === item.id) {
            if(audio.readyState >= 1) {
                audio.currentTime = resumeAt;
            } else {
                const seekOnce = () => { audio.currentTime = resumeAt; audio.removeEventListener('loadedmetadata', seekOnce); };
                audio.addEventListener('loadedmetadata', seekOnce);
            }
        }
        await playing;
        emit();
        return resumeAt;
    }

    async function play() {
        try { await audio.play(); }
        catch(err) {
            // iOS requires a user gesture for the first play()
            xf.dispatch('media:error', 'Tap play to start audio.');
        }
        emit();
    }

    function pause() { audio.pause(); emit(); }
    function toggle() { return audio.paused ? play() : pause(); }
    function seek(seconds) {
        if(!current) return;
        const max = isFinite(audio.duration) ? audio.duration : seconds;
        audio.currentTime = Math.max(0, Math.min(max, seconds));
        persist(true);
        emit();
    }
    function skip(deltaSeconds) { seek((audio.currentTime || 0) + deltaSeconds); }
    function setRate(rate) { audio.playbackRate = rate; emit(); }
    function setVolume(v) { audio.volume = Math.max(0, Math.min(1, v)); }
    function isPlaying() { return !!current && !audio.paused && !audio.ended; }
    function unload() {
        persist(true);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if(objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        current = null;
        emit();
    }

    // Lock screen / Control Center / headphone buttons
    function setupMediaSession() {
        const ms = navigator.mediaSession;
        if(!ms || !current) return;
        try {
            ms.metadata = new window.MediaMetadata({
                title:   current.title,
                artist:  current.subtitle,
                artwork: current.art ? [{src: current.art, sizes: '512x512'}] : [],
            });
            ms.setActionHandler('play',  () => play());
            ms.setActionHandler('pause', () => pause());
            ms.setActionHandler('seekbackward', () => skip(-15));
            ms.setActionHandler('seekforward',  () => skip(30));
        } catch(e) { /* optional API */ }
    }

    return Object.freeze({load, play, pause, toggle, seek, skip, setRate, setVolume, isPlaying, unload, state, audio});
}

let instance = null;
function localPlayer() {
    if(!instance) instance = LocalPlayer();
    return instance;
}

// File -> stable id so re-picking the same audiobook file resumes where you left off
function fileId(file) {
    return `file:${file.name}:${file.size}`;
}

export { localPlayer, fileId };
