import { xf, equals } from '../../functions.js';
import { ControlMode } from '../../ble/enums.js';
import { HrController, HrControlStatus } from './controller.js';
import { settings } from './settings.js';

//
// Wires the pure HrController to the app:
//   db:mode === 'heartRate'  -> controller running, ticking every second
//   db:heartRate             -> HR samples
//   db:heartRateTarget       -> controller target
//   controller output        -> ui:power-target-set (trainer stays in ERG)
//   status                   -> 'hr-control:status' for the views
//

const TICK_MS        = 1000;
const START_POWER    = 0.55; // of FTP, when there is no power target to start from
const PEDALING_GRACE = 5000; // ms without power/cadence before treating rider as stopped

function HrControlRuntime(args = {}) {
    const now = args.now ?? (() => Date.now());

    const ctrl = HrController(Object.assign({}, settings.toControllerConfig()));

    let mode            = ControlMode.erg;
    let powerTarget     = 0;
    let heartRateTarget = 0;
    let lastPedalAt     = null;
    let timer           = null;
    let lastOutput      = idleOutput();

    function idleOutput() {
        return {
            active:  false,
            status:  HrControlStatus.idle,
            power:   powerTarget,
            target:  heartRateTarget,
            message: '',
        };
    }

    function isActive() {
        return equals(mode, ControlMode.heartRate);
    }

    function onMode(value) {
        const wasActive = isActive();
        mode = value;
        if(isActive() && !wasActive) activate();
        if(!isActive() && wasActive) deactivate();
    }

    function activate() {
        if(!(heartRateTarget > 0)) {
            // no target yet, start from the last one the rider used
            xf.dispatch('ui:heart-rate-target-set', settings.load().lastTarget);
        }

        const ftp   = ctrl.getConfig().ftp;
        const start = powerTarget > 0 ? powerTarget : Math.round(START_POWER * ftp);
        const out   = ctrl.start({now: now(), power: start, target: heartRateTarget});

        // let every db:mode subscriber (trainer connections) see the new mode
        // before the first ERG target goes out
        setTimeout(() => {
            if(isActive()) xf.dispatch('ui:power-target-set', out.power);
        }, 0);

        clearInterval(timer);
        timer = setInterval(tick, TICK_MS);
        publish(out);
    }

    function deactivate() {
        ctrl.stop();
        clearInterval(timer);
        timer = null;
        publish(idleOutput());
    }

    function isPedaling(t) {
        return lastPedalAt !== null && (t - lastPedalAt) <= PEDALING_GRACE;
    }

    function tick() {
        if(!isActive()) return;
        const t   = now();
        const out = ctrl.tick(t, {pedaling: isPedaling(t)});

        if(out.power !== powerTarget) {
            xf.dispatch('ui:power-target-set', out.power);
        }
        publish(out);
    }

    function publish(out) {
        lastOutput = Object.assign({active: isActive()}, out);
        xf.dispatch('hr-control:status', lastOutput);
    }

    function onHeartRate(hr) {
        ctrl.addSample(hr, now());
    }

    function onHeartRateTarget(value) {
        heartRateTarget = value;
        ctrl.setTarget(value);
        settings.rememberTarget(value);
        if(isActive() && ctrl.isRunning()) publish(Object.assign({}, lastOutput, {target: value}));
    }

    function onPedalData(value) {
        if(value > 0) lastPedalAt = now();
    }

    function start() {
        xf.sub('db:mode',            onMode);
        xf.sub('db:powerTarget',     value => { powerTarget = value; });
        xf.sub('db:heartRateTarget', onHeartRateTarget);
        xf.sub('db:heartRate',       onHeartRate);
        xf.sub('db:power',           onPedalData);
        xf.sub('db:cadence',         onPedalData);
        xf.sub('db:ftp',             ftp => ctrl.configure({ftp}));
        xf.sub('hr-control:settings', values => {
            ctrl.configure(settings.toControllerConfig(values));
        });
        xf.sub('hr-control:status:request', () => publish(lastOutput));
    }

    start();

    return Object.freeze({
        controller: ctrl,
        isActive,
        tick,
        getStatus: () => lastOutput,
    });
}

export { HrControlRuntime };
