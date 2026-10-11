import { xf } from '../../functions.js';

// Persisted HR control settings, localStorage under `hr-control:*`
const keys = {
    maxPowerPct: 'hr-control:max-power-pct',
    maxHr:       'hr-control:max-hr',
    lastTarget:  'hr-control:last-target',
};

const fallback = {
    maxPowerPct: 110, // % of FTP
    maxHr:       0,   // bpm, 0 = off
    lastTarget:  130, // bpm
};

const limits = {
    maxPowerPct: [50, 200],
    maxHr:       [0, 230],
    lastTarget:  [60, 220],
};

function read(key) {
    try {
        const value = parseInt(window.localStorage.getItem(keys[key]));
        if(Number.isNaN(value)) return fallback[key];
        return clampSetting(key, value);
    } catch(e) {
        return fallback[key];
    }
}

function write(key, value) {
    try {
        window.localStorage.setItem(keys[key], String(value));
    } catch(e) {
        // storage unavailable, keep in memory only
    }
}

function clampSetting(key, value) {
    const [min, max] = limits[key];
    if(key === 'maxHr' && value <= 0) return 0;
    return Math.min(max, Math.max(min, value));
}

function load() {
    return {
        maxPowerPct: read('maxPowerPct'),
        maxHr:       read('maxHr'),
        lastTarget:  read('lastTarget'),
    };
}

function save(patch = {}) {
    const current = load();
    Object.keys(patch).forEach(key => {
        if(!(key in keys)) return;
        const value = parseInt(patch[key]);
        if(Number.isNaN(value)) return;
        current[key] = clampSetting(key, value);
        write(key, current[key]);
    });
    xf.dispatch('hr-control:settings', current);
    return current;
}

function rememberTarget(bpm) {
    const value = parseInt(bpm);
    if(Number.isNaN(value) || value <= 0) return;
    write('lastTarget', clampSetting('lastTarget', value));
}

// settings -> HrController options
function toControllerConfig(values = load()) {
    return {
        maxPowerPct: values.maxPowerPct / 100,
        maxHr:       values.maxHr,
    };
}

const settings = { keys, fallback, load, save, rememberTarget, toControllerConfig };

export { settings };
