//
// Pure helpers shared by the media UI and controller (no DOM / network).
//

// Spotify URL or URI -> URI ("https://open.spotify.com/playlist/abc?si=1" -> "spotify:playlist:abc")
function toSpotifyUri(input = '') {
    const s = String(input || '').trim();
    if(/^spotify:(playlist|album|artist|show|audiobook|track|episode):[A-Za-z0-9]+$/.test(s)) return s;
    const m = s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|artist|show|audiobook|track|episode)\/([A-Za-z0-9]+)/);
    return m ? `spotify:${m[1]}:${m[2]}` : null;
}

// Pick a reasonable artwork url from a Spotify images array
function pickImage(images = [], target = 300) {
    if(!Array.isArray(images) || images.length === 0) return '';
    const sorted = images.filter(i => i && i.url).slice().sort((a, b) => (a.width || 0) - (b.width || 0));
    const fit = sorted.find(i => (i.width || 0) >= target);
    return (fit || sorted[sorted.length - 1] || {}).url || '';
}

// Is the currently playing Spotify item spoken word (podcast episode / audiobook chapter)?
function isSpoken(playback) {
    if(!playback) return false;
    if(playback.currently_playing_type === 'episode') return true;
    const item = playback.item;
    if(!item) return false;
    return item.type === 'episode' || item.type === 'chapter' || !!item.show || !!item.audiobook;
}

// GET /me/player response -> UI model
function toNowPlaying(playback, fetchedAt = Date.now()) {
    if(!playback || !playback.item) {
        return {
            source: 'spotify', active: !!playback, isPlaying: false, title: '', subtitle: '',
            art: '', progressMs: 0, durationMs: 0, spoken: false, uri: '', contextUri: playback?.context?.uri || '',
            device: playback?.device || null, fetchedAt,
        };
    }
    const item = playback.item;
    let subtitle = '';
    let art = '';
    if(item.type === 'track') {
        subtitle = (item.artists || []).map(a => a.name).join(', ');
        art = pickImage(item.album?.images);
    } else {
        const parent = item.show || item.audiobook || {};
        subtitle = parent.name || parent.publisher || '';
        art = pickImage(item.images) || pickImage(parent.images);
    }
    return {
        source:     'spotify',
        active:     true,
        isPlaying:  !!playback.is_playing,
        title:      item.name || '',
        subtitle,
        art,
        progressMs: playback.progress_ms || 0,
        durationMs: item.duration_ms || 0,
        spoken:     isSpoken(playback),
        uri:        item.uri || '',
        contextUri: playback.context?.uri || '',
        device:     playback.device || null,
        volume:     playback.device?.volume_percent ?? null,
        fetchedAt,
    };
}

// Interpolate progress between polls
function liveProgress(np, now = Date.now()) {
    if(!np) return 0;
    if(!np.isPlaying) return np.progressMs || 0;
    const p = (np.progressMs || 0) + Math.max(0, now - (np.fetchedAt ?? now));
    return np.durationMs ? Math.min(np.durationMs, p) : p;
}

function formatTime(ms = 0) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Spotify resume_point -> {positionMs, fullyPlayed, fraction}
function resumeInfo(item) {
    const rp = item && item.resume_point;
    if(!rp) return {positionMs: 0, fullyPlayed: false, fraction: 0};
    const positionMs = rp.fully_played ? 0 : (rp.resume_position_ms || 0);
    const fraction = rp.fully_played ? 1 : (item.duration_ms ? Math.min(1, positionMs / item.duration_ms) : 0);
    return {positionMs, fullyPlayed: !!rp.fully_played, fraction};
}

// Chapters list -> chapter to resume (first not fully played, with position)
function resumeChapter(chapters = []) {
    const list = chapters.filter(Boolean);
    const started = list.find(c => !resumeInfo(c).fullyPlayed && resumeInfo(c).positionMs > 0);
    const target = started || list.find(c => !resumeInfo(c).fullyPlayed) || list[0] || null;
    return target ? {chapter: target, positionMs: resumeInfo(target).positionMs} : null;
}

// Where the Web Playback SDK can run. It does not run on iOS/iPadOS browsers
// (all of them are WebKit) nor on Android browsers; it needs EME (Widevine/FairPlay).
function webPlaybackSupport({userAgent = '', platform = '', maxTouchPoints = 0, hasEME = true} = {}) {
    const ua = userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
    if(iOS) return {supported: false, reason: 'ios', message: 'iPad/iPhone browsers cannot play Spotify in the page. Control the Spotify app instead (Spotify Connect).'};
    if(/Android/i.test(ua)) return {supported: false, reason: 'android', message: 'Mobile browsers cannot play Spotify in the page. Control the Spotify app instead (Spotify Connect).'};
    if(!hasEME) return {supported: false, reason: 'eme', message: 'This browser lacks Encrypted Media Extensions, needed for in-browser Spotify playback.'};
    return {supported: true, reason: '', message: 'This browser can play Spotify directly (Premium required).'};
}

function escapeHtml(s = '') {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export {
    toSpotifyUri,
    pickImage,
    isSpoken,
    toNowPlaying,
    liveProgress,
    formatTime,
    resumeInfo,
    resumeChapter,
    webPlaybackSupport,
    escapeHtml,
};
