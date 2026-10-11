//
// Web Speech helpers for hands-free review.
//
// Support notes:
// - speechSynthesis: Safari/iPadOS, Chrome, Edge, Firefox. On iOS the first
//   utterance must start inside a user gesture (we call unlock() from the tap
//   that enables hands-free mode). `onend` occasionally never fires on iOS, so
//   speak() also resolves on an estimated-duration timeout.
// - SpeechRecognition: Chrome/Edge (webkitSpeechRecognition, needs network),
//   Safari 14.5+ incl. iPadOS (webkitSpeechRecognition, requires Siri/dictation
//   enabled and asks for mic permission; single-shot and sometimes flaky).
//   Firefox: not supported. Voice grading is therefore optional and every
//   prompt still has big tap targets.
//

function synthSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window &&
           typeof window.SpeechSynthesisUtterance !== 'undefined';
}

function recognitionCtor() {
    if(typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function recognitionSupported() {
    return !!recognitionCtor();
}

function unlock() {
    if(!synthSupported()) return;
    try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
    } catch(e) { /* ignore */ }
}

function cancel() {
    if(synthSupported()) window.speechSynthesis.cancel();
}

function speak(text, { rate = 1, lang } = {}) {
    if(!synthSupported() || !text) return Promise.resolve();
    return new Promise(resolve => {
        cancel();
        const u = new SpeechSynthesisUtterance(String(text).replace(/\[\.\.\.\]/g, 'blank'));
        u.rate = rate;
        if(lang) u.lang = lang;
        let done = false;
        const finish = () => { if(!done) { done = true; resolve(); } };
        u.onend = finish;
        u.onerror = finish;
        // ~ 14 chars/sec at rate 1, plus margin
        setTimeout(finish, 1500 + (String(text).length / 14) * 1000 / rate);
        window.speechSynthesis.speak(u);
    });
}

const words = [
    [/\b(again|fail|forgot|no|wrong|miss(ed)?)\b/, 1],
    [/\b(hard|difficult|tough)\b/, 2],
    [/\b(good|yes|correct|right|got it|ok(ay)?|next)\b/, 3],
    [/\b(easy|trivial|simple)\b/, 4],
    [/\b(skip|pass)\b/, 'skip'],
    [/\b(repeat|again please|say again|what)\b/, 'repeat'],
];

function ratingFromTranscript(text = '') {
    const t = String(text).toLowerCase();
    // check 'repeat' phrases first so "say again" isn't read as Again
    if(/\b(repeat|say again|again please)\b/.test(t)) return 'repeat';
    for(const [re, value] of words) {
        if(re.test(t)) return value;
    }
    return null;
}

// Listen once; resolves to 1..4 | 'skip' | 'repeat' | null (no match / unsupported / timeout)
function listen({ timeoutMs = 6000, lang } = {}) {
    const Ctor = recognitionCtor();
    if(!Ctor) return Promise.resolve(null);
    return new Promise(resolve => {
        let rec, done = false;
        const finish = (v) => {
            if(done) return;
            done = true;
            try { rec && rec.abort(); } catch(e) { /* ignore */ }
            resolve(v);
        };
        try {
            rec = new Ctor();
            rec.lang = lang || (navigator.language || 'en-US');
            rec.interimResults = false;
            rec.maxAlternatives = 3;
            rec.continuous = false;
            rec.onresult = (e) => {
                for(const alt of Array.from(e.results[0] || [])) {
                    const r = ratingFromTranscript(alt.transcript);
                    if(r !== null) return finish(r);
                }
                finish(null);
            };
            rec.onerror = () => finish(null);
            rec.onend = () => finish(null);
            rec.start();
        } catch(e) {
            finish(null);
        }
        setTimeout(() => finish(null), timeoutMs);
    });
}

export {
    synthSupported,
    recognitionSupported,
    unlock,
    cancel,
    speak,
    listen,
    ratingFromTranscript,
};
