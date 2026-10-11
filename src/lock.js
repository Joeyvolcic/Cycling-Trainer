import { xf } from './functions.js';

// Screen Wake Lock: keep the display on while the app is open and, most importantly,
// during a ride. Safari (iPadOS 16.4+) supports the API, but it is only granted while
// the page is visible and may require a user gesture, so we also retry on
// 'watch:started' (tap on play) and on the first touch after a release.
class WakeLock {
    constructor(args) {
        this.lock = undefined;
        this.isLocked = false;
        this.isLocable = false;
        this.isVisible = false;
        this.isRequesting = false;
        this.failures = 0;
        this.init();
    }
    init() {
        let self = this;
        self.isLocable = ('wakeLock' in navigator);
        self.isVisible = self.checkVisibility();

        self.lockScreen();

        document.addEventListener('visibilitychange', self.onVisibilityChange.bind(self));
        // re-acquire on user interaction (some browsers require a gesture)
        document.addEventListener('pointerup', () => {
            if(!self.isLocked && self.failures < 3) self.lockScreen();
        }, {passive: true});
        xf.sub('watch:started', () => self.lockScreen());

        window.addEventListener('beforeunload', e => {
            xf.dispatch('lock:beforeunload');
        });
    }
    checkVisibility() {
        let isVisible = false;
        let visibilityState = document.visibilityState;

        if(visibilityState === 'visible') {
            isVisible = true;
        } else {
            isVisible = false;
        }
        return isVisible;
    }
    onVisibilityChange () {
        let self = this;

        self.isVisible = self.checkVisibility();
        if(self.isVisible) {
            self.lockScreen();
        }
    }
    async lockScreen() {
        let self = this;
        if(self.isLocable && self.isVisible && !self.isLocked && !self.isRequesting) {
            self.isRequesting = true;
            try {
                let lock = await navigator.wakeLock.request('screen');
                self.lock = lock;
                self.isLocked = true;
                self.failures = 0;
                xf.dispatch('lock:acquired');

                lock.addEventListener('release', e => {
                    self.isLocked = false;
                    xf.dispatch('lock:release');
                    console.log(`Wake lock released.`);
                });
            } catch(e) {
                self.failures += 1;
                console.warn(`wake-lock: not-supported:`, e);
            } finally {
                self.isRequesting = false;
            }
        }
    }
}

const lock = new WakeLock();

export { lock };
