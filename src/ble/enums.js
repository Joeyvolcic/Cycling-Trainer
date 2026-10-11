const Status = {
    disconnected: "disconnected",
    connected: "connected",
    connecting: "connecting",
    disconnecting: "disconnecting",
};

const Device = {
    controllable: 'controllable',
    speedCadenceSensor: 'speedCadenceSensor',
    powerMeter: 'powerMeter',
    heartRateMonitor: 'heartRateMonitor',
    raceController: 'raceController',
    smo2: 'smo2',
    coreTemp: 'coreTemp',
    generic: 'generic',
};

const Metric = {
    power: 'power',
    cadence: 'cadence',
    heartRate: 'heartRate',
    smo2: 'smo2',
    thb: 'thb',
    coreBodyTemperature: 'coreBodyTemperature',
    skinTemperature: 'skinTemperature',
};

const Responsibility = {
    controllable: [Metric.power, Metric.cadence, Metric.heartRate],
    powerMeter: [Metric.power, Metric.cadence],
    speedCadenceSensor: [Metric.cadence],
    heartRateMonitor: [Metric.heartRate, Metric.cadence],
    smo2: [Metric.smo2, Metric.thb],
};

const Priority = {
    power: [
        Device.powerMeter,
        Device.controllable,
    ],
    cadence: [
        Device.speedCadenceSensor,
        Device.powerMeter,
        Device.controllable,
        Device.heartRateMonitor,
    ],
    heartRate: [
        Device.heartRateMonitor,
        Device.controllable,
    ],
    smo2: [
        Device.smo2,
    ],
    coreTemp: [
        Device.coreTemp,
    ]
};

const ControlMode = {
    erg: 'erg',
    sim: 'sim',
    resistance: 'resistance',
    virtualGear: 'virtualGear',
    // software closed loop on top of ERG, see src/integrations/hr-control
    heartRate: 'heartRate',
};

// modes in which the trainer is driven with ERG power targets
function isPowerTargetMode(mode) {
    return mode === ControlMode.erg || mode === ControlMode.heartRate;
}

export {
    Status,
    Device,
    Metric,
    Responsibility,
    Priority,
    ControlMode,
    isPowerTargetMode,
};

