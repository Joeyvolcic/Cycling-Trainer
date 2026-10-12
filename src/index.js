import { xf } from './functions.js';
import './db.js';
import './views/views.js';
import './integrations/plans/index.js';
import './ble/devices.js';
import './watch.js';
import './course.js';
import './lock.js';
import './integrations/ai/index.js';
import './integrations/hr-control/index.js';
import './integrations/calendar/calendar.js';
import './integrations/calendar/settings-view.js';
import './integrations/quiz/index.js';
import './integrations/media/media.js';
import './integrations/analysis/index.js';
import './integrations/ui/index.js';

function startServiceWorker() {
    if('serviceWorker' in navigator) {
        try {
            // const reg = navigator.serviceWorker.register('./sw.js');

            const reg = navigator.serviceWorker.register(
                new URL('./sw.js', import.meta.url),
                {type: 'module'}
            );

            console.log(`SW: register success.`);
            console.log('Cache Version: Flux-v003');
        } catch(err) {
            console.log(`SW: register error: `, err);
        }
    };
}

// Ask the browser not to evict ride history and plans under storage pressure
async function persistStorage() {
    try {
        if(!navigator.storage?.persist) return;
        if(await navigator.storage.persisted()) return;
        const granted = await navigator.storage.persist();
        console.log(`storage: persistent ${granted ? 'granted' : 'denied'}`);
    } catch(e) {
        console.warn('storage: persist failed', e);
    }
}

function start() {
    console.log('start app.');

    persistStorage();
    // startServiceWorker(); // stable version only
    xf.dispatch('app:start');
}

function stop() {
    xf.dispatch('app:stop');
}

start();

export {
    start,
    stop,
};

