import { xf, equals } from '../../functions.js';
import { ControlMode } from '../../ble/enums.js';
import { HrControlStatus } from './controller.js';
import { settings } from './settings.js';
import { athlete, toBpm, toLthrPct } from './targets.js';
import * as analysisSettings from '../analysis/settings.js';

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
        this.$lthr   = this.querySelector('.hr-control--lthr');
        this.target  = 0;

        this.$inc.addEventListener('pointerup', () => xf.dispatch('ui:heart-rate-target-inc'), signal);
        this.$dec.addEventListener('pointerup', () => xf.dispatch('ui:heart-rate-target-dec'), signal);
        this.$input.addEventListener('change', e => {
            // bpm, or a fraction of LTHR (e.g. 0.85) when LTHR is set
            const bpm = toBpm(parseFloat(e.target.value));
            if(bpm !== null) {
                xf.dispatch('ui:heart-rate-target-set', bpm);
            } else {
                this.onTarget(this.target);
            }
        }, signal);

        xf.sub('db:heartRateTarget', this.onTarget.bind(this), signal);
        xf.sub('analysis:settings', () => this.renderLthr(), signal);
        xf.sub('hr-control:status', this.onStatus.bind(this), signal);
        xf.dispatch('hr-control:status:request');
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onTarget(value) {
        this.target = value;
        this.$input.value = value > 0 ? value : '';
        this.renderLthr();
    }
    renderLthr() {
        if(!this.$lthr) return;
        const pct = toLthrPct(this.target);
        this.$lthr.textContent = pct === null ? '' : `${pct}% LTHR`;
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
// <hr-control-settings>: max power (% FTP) and max HR ceiling, plus the
// athlete's LTHR / max HR. Those two are stored with the ride analysis settings
// ('analysis:lthr', 'analysis:max-hr'), the single source of truth for HR zones
// and for workout HR targets written as a fraction of LTHR.
//
class HrControlSettings extends HTMLElement {
    connectedCallback() {
        this.abortController = new AbortController();
        const signal = { signal: this.abortController.signal };

        this.$maxPower = this.querySelector('.hr-settings--max-power');
        this.$maxHr    = this.querySelector('.hr-settings--max-hr');
        this.$save     = this.querySelector('.hr-settings--save');
        this.$lthr     = this.querySelector('.hr-settings--lthr');
        this.$athleteMaxHr = this.querySelector('.hr-settings--athlete-max-hr');

        this.render(settings.load());

        this.$save.addEventListener('pointerup', this.onSave.bind(this), signal);
        xf.sub('hr-control:settings', this.render.bind(this), signal);
        xf.sub('analysis:settings', () => this.renderAthlete(), signal);
    }
    disconnectedCallback() {
        this.abortController.abort();
    }
    onSave() {
        if(this.$lthr || this.$athleteMaxHr) {
            const int = el => {
                const v = parseInt(el?.value);
                return Number.isFinite(v) && v > 0 ? v : '';
            };
            if(this.$lthr) analysisSettings.set(analysisSettings.Keys.lthr, int(this.$lthr));
            if(this.$athleteMaxHr) analysisSettings.set(analysisSettings.Keys.maxHr, int(this.$athleteMaxHr));
            xf.dispatch('analysis:settings', 'athlete');
        }
        settings.save({
            maxPowerPct: this.$maxPower.value,
            maxHr:       this.$maxHr.value === '' ? 0 : this.$maxHr.value,
        });
    }
    render(values) {
        this.$maxPower.value = values.maxPowerPct;
        this.$maxHr.value    = values.maxHr > 0 ? values.maxHr : '';
        this.renderAthlete();
    }
    renderAthlete() {
        const a = athlete();
        if(this.$lthr) this.$lthr.value = a.lthr ?? '';
        if(this.$athleteMaxHr) this.$athleteMaxHr.value = a.maxHr ?? '';
    }
}

customElements.define('hr-control-settings', HrControlSettings);

export { HrTargetControl, HeartRateGroup, HrControlSettings };
