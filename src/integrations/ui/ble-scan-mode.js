import { webBle } from '../../ble/web-ble.js';

// Settings switch: list every nearby Bluetooth device when connecting, for
// trainers the filtered search misses (e.g. Wahoo KICKR v1 on iPad/Bluefy).
class BleScanMode extends HTMLElement {
    connectedCallback() {
        this.innerHTML = `
            <div class="list--row--outer">
                <div class="list--row--inner list--heading--cont">
                    <h2 class="list--sub-heading">Bluetooth</h2>
                </div>
            </div>
            <div class="list--row--outer">
                <label class="ble-scan-mode--row" for="ble-show-all-devices">
                    <input type="checkbox" id="ble-show-all-devices">
                    <span>
                        <span class="ble-scan-mode--title">Show all Bluetooth devices</span>
                        <span class="ble-scan-mode--hint">Turn on if your trainer or sensor doesn't appear when you tap Trainer or Heart Rate. You then pick it by name from every nearby device.</span>
                    </span>
                </label>
            </div>
            <div class="list--row--outer">
                <div class="ble-scan-mode--test">
                    <button type="button" id="ble-test-btn" class="ble-scan-mode--btn">Test Bluetooth</button>
                    <pre id="ble-test-out" class="ble-scan-mode--out" hidden></pre>
                </div>
            </div>`;

        const input = this.querySelector('#ble-show-all-devices');
        input.checked = webBle.showAllDevices();
        input.addEventListener('change', () => webBle.setShowAllDevices(input.checked));

        this.querySelector('#ble-test-btn').addEventListener('click', () => this.test());
    }

    // Reports what the browser's Bluetooth layer can see, then opens an
    // unfiltered device list. Must run from the tap (requestDevice needs it).
    async test() {
        const out = this.querySelector('#ble-test-out');
        const lines = [];
        const show = () => { out.hidden = false; out.textContent = lines.join('\n'); };

        const bt = navigator.bluetooth;
        lines.push(`Bluetooth in this browser: ${bt ? 'yes' : 'NO (open the app in Bluefy, not Safari)'}`);
        lines.push(`Show all devices: ${webBle.showAllDevices() ? 'on' : 'off'}`);
        if(!bt) return show();

        // start the device list before any await so the tap still counts
        const request = bt.requestDevice(webBle.filters.everything());

        try {
            if(bt.getAvailability) {
                const available = await bt.getAvailability();
                lines.push(`Bluetooth radio available: ${available ? 'yes' : 'NO (Bluetooth off, or Bluefy not allowed in iPad Settings → Privacy & Security → Bluetooth)'}`);
            } else {
                lines.push('Bluetooth radio available: unknown (browser does not report it)');
            }
        } catch(e) {
            lines.push(`Bluetooth radio available: error: ${e.message}`);
        }
        lines.push('Opening the list of all nearby devices…');
        show();

        try {
            const device = await request;
            lines.push(`Picked: "${device.name ?? '(no name)'}"`);
            try { device.gatt?.connected && device.gatt.disconnect(); } catch(e) {}
        } catch(e) {
            lines.push(`List closed: ${e.name}: ${e.message}`);
        }
        show();
    }
}

const style = document.createElement('style');
style.textContent = `
    .ble-scan-mode--row { display: flex; gap: 14px; align-items: center; min-height: 56px; padding: 8px 0; cursor: pointer; width: 100%; }
    .ble-scan-mode--row input { width: 28px; height: 28px; flex: 0 0 auto; }
    .ble-scan-mode--title { display: block; font-size: 1.6rem; font-weight: 700; }
    .ble-scan-mode--hint { display: block; font-size: 1.3rem; opacity: 0.7; margin-top: 2px; }
    .ble-scan-mode--test { display: grid; gap: 10px; padding: 8px 0; width: 100%; }
    .ble-scan-mode--btn { justify-self: start; min-height: 48px; padding: 0 20px; border-radius: 8px; border: 1px solid currentColor; background: transparent; color: inherit; font-size: 1.6rem; font-weight: 700; cursor: pointer; }
    .ble-scan-mode--out { margin: 0; padding: 10px 12px; border-radius: 8px; background: rgba(127,127,127,0.15); font-size: 1.4rem; white-space: pre-wrap; overflow-wrap: anywhere; }
`;
document.head.appendChild(style);

customElements.define('ble-scan-mode', BleScanMode);

export { BleScanMode };
