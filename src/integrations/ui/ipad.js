import { xf } from '../../functions.js';
import { capabilities, guidance, applyPlatformClasses, isIOS } from './platform.js';

// iPad / touch readiness:
// - platform classes on <html> (is-ios, is-ipad, is-standalone, is-touch, no-bluetooth)
// - explain *why* connecting fails when the browser has no Web Bluetooth / WebUSB
//   instead of failing silently (iPadOS Safari)
// - block pinch-zoom while riding (iOS ignores user-scalable=no)

const BLE_DEVICES = ['controllable', 'heartRateMonitor', 'powerMeter', 'speedCadenceSensor', 'smo2', 'coreTemp'];

function showGuide(info = guidance()) {
    let dialog = document.getElementById('platform-guide');
    if(!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'platform-guide';
        dialog.className = 'dialog platform-guide';
        document.body.appendChild(dialog);
    }
    dialog.innerHTML =
        `<h2 class="platform-guide--title">${info.title}</h2>
         <div class="platform-guide--body">${info.html}</div>
         <form method="dialog"><button class="platform-guide--ok" value="ok">Got it</button></form>`;
    if(typeof dialog.showModal === 'function') {
        if(!dialog.open) dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
        dialog.querySelector('form').addEventListener('submit', e => {
            e.preventDefault();
            dialog.removeAttribute('open');
        }, {once: true});
    }
}

function antGuide() {
    return {
        title: 'ANT+ USB isn\'t available here',
        html: isIOS()
            ? `<p>iPad and iPhone browsers can't access USB devices, so ANT+ sticks won't work. Use your trainer's Bluetooth connection instead.</p>`
            : `<p>This browser has no WebUSB / Web Serial. Use Chrome or Edge on a desktop computer for ANT+ sticks, or connect over Bluetooth.</p>`,
    };
}

function guardConnections() {
    const caps = capabilities();
    if(!caps.bluetooth) {
        for(const id of BLE_DEVICES) {
            xf.sub(`ui:ble:${id}:switch`, () => showGuide());
        }
    }
    if(!caps.usb && !caps.serial) {
        xf.sub('ui:ant:hrm:switch', () => showGuide(antGuide()));
        xf.sub('ui:ant:driver:switch', () => showGuide(antGuide()));
    }
}

function preventRideZoom() {
    let riding = false;
    xf.sub('db:watchStatus', s => { riding = (s === 'started'); });
    // Safari-only gesture events (pinch). Only block while riding so normal zoom still works.
    const block = e => { if(riding) e.preventDefault(); };
    document.addEventListener('gesturestart', block, {passive: false});
    document.addEventListener('gesturechange', block, {passive: false});
    // Ctrl/trackpad pinch on desktop Safari/Chrome produces ctrl+wheel
    document.addEventListener('wheel', e => { if(riding && e.ctrlKey) e.preventDefault(); }, {passive: false});
}

function start() {
    if(typeof document === 'undefined') return;
    applyPlatformClasses();
    window.matchMedia?.('(display-mode: standalone)')?.addEventListener?.('change', () => applyPlatformClasses());
    guardConnections();
    preventRideZoom();
    xf.sub('ui:platform:guide', () => showGuide());
    xf.sub('ble:wrong-device', ({slot, name}) => showGuide(wrongDeviceGuide(slot, name)));
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function wrongDeviceGuide(slot, name) {
    const device = `<b>${escapeHtml(name || 'That device')}</b>`;
    if(slot === 'heartRateMonitor') {
        return {
            title: 'That isn\'t a heart rate monitor',
            html: `<p>${device} doesn't send heart rate, so it was disconnected.</p>
                   <p>On a Garmin watch, start <b>Broadcast Heart Rate</b> and wait until it shows your heart rate. Without the broadcast the watch connects but sends no heart rate.</p>
                   <p>Then turn off <b>Settings → Bluetooth → Show all Bluetooth devices</b> (a connected trainer stays connected) and tap <b>Heart Rate</b> again. Only devices that are broadcasting heart rate will be listed.</p>`,
        };
    }
    return {
        title: 'That isn\'t a trainer',
        html: `<p>${device} doesn't send power or accept trainer control, so it was disconnected.</p>
               <p>Tap <b>Trainer</b> again and pick your trainer, for example <b>KICKR CORE</b>. Connect your watch with the <b>Heart Rate</b> button instead.</p>`,
    };
}

export { start, showGuide };
