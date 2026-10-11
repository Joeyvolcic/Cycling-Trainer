import { xf, equals } from '../../functions.js';
import { ControlMode } from '../../ble/enums.js';
import { HrControlStatus } from './controller.js';
import { settings } from './settings.js';

const warningStatuses = [
    HrControlStatus.signalLost,
    HrControlStatus.signalLostSafe,
    HrControlStatus.ceiling,
];

//
// <hr-target-control>: -/+ and input for the target heart rate, plus the
// controller status line, inside the 'heartRate' tab of the mode controls.
//
class HrTargetControl extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };

        this.$input  = this.querySelector('.hr-target--input');
        this.$inc    = this.querySelector('.hr-target--inc');
        this.$dec    = this.querySelector('.hr-target--dec');
        this.$status = this.querySelector('.hr-control--status');
        this.$power  = this.querySelector('.hr-control--power');
        this.$msg    = this.querySelector('.hr-control--message');

        this.$inc.addEventListener('pointerup', () => xf.dispatch('ui:heart-rate-target-inc'), signal);
        this.$dec.addEventListener('pointerup', () => xf.dispatch('ui:heart-rate-target-dec'), signal);
        this.$input.addEventListener('change', e => {
            xf.dispatch('ui:heart-rate-target-set', parseInt(e.target.value));
        }, signal);

        xf.sub('db:heartRateTarget', this.onTarget.bind(this), signal);
        xf.sub('hr-control:status', this.onStatus.bind(this), signal);
        xf.dispatch('hr-control:status:request');
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onTarget(value) {
        this.$input.value = value > 0 ? value : '';
    }
    onStatus(status) {
        const warning = warningStatuses.includes(status.status);
        this.$status.classList.toggle('warning', warning);
        this.$status.setAttribute('status', status.status);
        this.$power.textContent = status.active ? `${status.power} W` : '';
        this.$msg.textContent   = status.active ? status.message : '';
    }
}

customElements.define('hr-target-control', HrTargetControl);

//
// <heart-rate-group>: shows the target heart rate next to the live value in
// the Heart Rate data tile while heart-rate mode is on.
//
class HeartRateGroup extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };

        this.mode   = ControlMode.erg;
        this.target = 0;
        this.$main  = this.querySelector('heart-rate-value');
        this.$aux   = this.querySelector('.heart-rate-target');

        xf.sub('db:mode', mode => { this.mode = mode; this.render(); }, signal);
        xf.sub('db:heartRateTarget', target => { this.target = target; this.render(); }, signal);
        xf.sub('hr-control:status', status => {
            this.$aux?.classList.toggle('warning', warningStatuses.includes(status.status));
        }, signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    render() {
        const show = equals(this.mode, ControlMode.heartRate) && this.target > 0;
        this.classList.toggle('complex', show);
        this.$main?.classList.toggle('active', show);
        if(this.$aux) {
            this.$aux.classList.toggle('active', show);
            this.$aux.textContent = show ? this.target : '';
        }
    }
}

customElements.define('heart-rate-group', HeartRateGroup);

//
// <hr-control-settings>: max power (% FTP) and max HR ceiling.
//
class HrControlSettings extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };

        this.$maxPower = this.querySelector('.hr-settings--max-power');
        this.$maxHr    = this.querySelector('.hr-settings--max-hr');
        this.$save     = this.querySelector('.hr-settings--save');

        this.render(settings.load());

        this.$save.addEventListener('pointerup', this.onSave.bind(this), signal);
        xf.sub('hr-control:settings', this.render.bind(this), signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onSave() {
        settings.save({
            maxPowerPct: this.$maxPower.value,
            maxHr:       this.$maxHr.value === '' ? 0 : this.$maxHr.value,
        });
    }
    render(values) {
        this.$maxPower.value = values.maxPowerPct;
        this.$maxHr.value    = values.maxHr > 0 ? values.maxHr : '';
    }
}

customElements.define('hr-control-settings', HrControlSettings);

export { HrTargetControl, HeartRateGroup, HrControlSettings };
