// Platform detection + capability guidance (iPad / iOS readiness).
// Pure functions take an optional `env` ({navigator, window}) so they can be unit tested.
// See doc/ipad.md for the research behind the guidance text.

function getEnv(env = {}) {
    return {
        navigator: env.navigator ?? (typeof navigator !== 'undefined' ? navigator : {}),
        window:    env.window    ?? (typeof window !== 'undefined' ? window : {}),
    };
}

// iPadOS 13+ Safari reports a desktop (Macintosh) user agent, so we also look at touch points.
function isIOS(env) {
    const { navigator: nav } = getEnv(env);
    const ua = nav.userAgent ?? '';
    if(/iPad|iPhone|iPod/.test(ua)) return true;
    return (nav.platform === 'MacIntel' || /Macintosh/.test(ua)) && (nav.maxTouchPoints ?? 0) > 1;
}

function isIPad(env) {
    const { navigator: nav } = getEnv(env);
    const ua = nav.userAgent ?? '';
    if(/iPad/.test(ua)) return true;
    return (nav.platform === 'MacIntel' || /Macintosh/.test(ua)) && (nav.maxTouchPoints ?? 0) > 1;
}

// Bluefy (and the older WebBLE app) are WKWebView browsers that inject navigator.bluetooth.
function isBluefy(env) {
    const { navigator: nav } = getEnv(env);
    return /Bluefy/i.test(nav.userAgent ?? '');
}

function isStandalone(env) {
    const { navigator: nav, window: win } = getEnv(env);
    if(nav.standalone === true) return true; // iOS home-screen web app
    try {
        return !!win.matchMedia?.('(display-mode: standalone)')?.matches;
    } catch(e) {
        return false;
    }
}

function capabilities(env) {
    const { navigator: nav } = getEnv(env);
    return {
        bluetooth: 'bluetooth' in nav,
        usb:       'usb' in nav,
        serial:    'serial' in nav,
        wakeLock:  'wakeLock' in nav,
        touch:     (nav.maxTouchPoints ?? 0) > 0,
    };
}

// -> {level: 'ok'|'warn'|'error', title, html}
function guidance(env) {
    const caps = capabilities(env);
    const ios  = isIOS(env);

    if(caps.bluetooth) {
        if(ios) {
            return {
                level: 'ok',
                title: 'Bluetooth ready',
                html: `<p>Bluetooth trainers, power meters and heart-rate straps work in this browser.
                       ANT+ USB sticks are not available on iPad/iPhone.</p>`,
            };
        }
        return { level: 'ok', title: 'Bluetooth ready', html: '' };
    }

    if(ios) {
        const device = isIPad(env) ? 'iPad' : 'iPhone';
        return {
            level: 'error',
            title: `Safari on ${device} can't talk to your trainer`,
            html:
            `<p>Apple doesn't allow Web Bluetooth in Safari, Chrome or Edge on ${device} (they all use Safari's engine), so the app can't connect to Bluetooth trainers or sensors here.</p>
             <ol>
               <li>Install <a href="https://apps.apple.com/app/id1492822055" target="_blank" rel="noopener"><b>Bluefy – Web BLE Browser</b></a> from the App Store (free).</li>
               <li>Open <b>${(getEnv(env).window.location?.host) || 'this site'}</b> in Bluefy and tap <b>Trainer</b> to pair.</li>
               <li>Keep the screen on: Settings &rsaquo; Display &amp; Brightness &rsaquo; Auto-Lock &rsaquo; Never (Bluefy may not honour the in-app wake lock).</li>
             </ol>
             <p class="platform-note">You can still use workouts, plans and the other panels here in Safari. ANT+ USB sticks are not supported on iPad/iPhone in any browser.</p>`,
        };
    }

    return {
        level: 'error',
        title: 'This browser has no Web Bluetooth',
        html:
        `<p>Please open the app in <a href="https://www.google.com/chrome/" target="_blank" rel="noopener">Chrome</a>
            or <a href="https://www.microsoft.com/edge" target="_blank" rel="noopener">Edge</a> on desktop or Android
            to connect a trainer. On iPad/iPhone use <a href="https://apps.apple.com/app/id1492822055" target="_blank" rel="noopener">Bluefy</a>.</p>`,
    };
}

function applyPlatformClasses(env) {
    const { window: win } = getEnv(env);
    const doc = win.document;
    if(!doc?.documentElement) return;
    const caps = capabilities(env);
    const root = doc.documentElement;
    root.classList.toggle('is-ios', isIOS(env));
    root.classList.toggle('is-ipad', isIPad(env));
    root.classList.toggle('is-standalone', isStandalone(env));
    root.classList.toggle('is-touch', caps.touch);
    root.classList.toggle('no-bluetooth', !caps.bluetooth);
}

export {
    isIOS,
    isIPad,
    isBluefy,
    isStandalone,
    capabilities,
    guidance,
    applyPlatformClasses,
};
