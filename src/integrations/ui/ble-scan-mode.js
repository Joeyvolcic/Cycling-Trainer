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
            </div>`;

        const input = this.querySelector('#ble-show-all-devices');
        input.checked = webBle.showAllDevices();
        input.addEventListener('change', () => webBle.setShowAllDevices(input.checked));
    }
}

const style = document.createElement('style');
style.textContent = `
    .ble-scan-mode--row { display: flex; gap: 14px; align-items: center; min-height: 56px; padding: 8px 0; cursor: pointer; width: 100%; }
    .ble-scan-mode--row input { width: 28px; height: 28px; flex: 0 0 auto; }
    .ble-scan-mode--title { display: block; font-size: 1.6rem; font-weight: 700; }
    .ble-scan-mode--hint { display: block; font-size: 1.3rem; opacity: 0.7; margin-top: 2px; }
`;
document.head.appendChild(style);

customElements.define('ble-scan-mode', BleScanMode);

export { BleScanMode };
