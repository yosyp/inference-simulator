// The app's calibration: benchmarks/derived/calibration.json, imported at build time (03 §8, K10).
import raw from '../../benchmarks/derived/calibration.json';
import { parseCalibration, type Calibration } from '../engine/calibration.ts';

export const calibration: Calibration = parseCalibration(raw);
