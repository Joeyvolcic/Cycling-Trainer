// Heart-rate control mode: hold a target heart rate by steering the ERG target.
import './views.js';
import { HrControlRuntime } from './hr-control.js';

const hrControl = HrControlRuntime();

export { hrControl };
