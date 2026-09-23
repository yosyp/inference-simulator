import { describe, expect, it } from 'vitest';
import raw from '../../benchmarks/derived/calibration.json';
import { parseCalibration } from '../engine/calibration.ts';
import { calibration } from './calibration.ts';

describe('calibration', () => {
  it('loads and validates the committed file', () => {
    expect(calibration.schemaVersion).toBe(1);
    expect(calibration.engine.kvPoolTokens % calibration.engine.blockSize).toBe(0);
  });

  it('matches the KV arithmetic in 03 §3', () => {
    const m = calibration.model;
    expect(m.kvBytesPerToken).toBe(m.layers * m.kvHeads * m.headDim * 2 * 2);
  });

  it('rejects invalid files with the offending path', () => {
    const bad = structuredClone(raw) as { costModel: { computeEfficiency: number } };
    bad.costModel.computeEfficiency = 1.5;
    expect(() => parseCalibration(bad)).toThrow(/costModel\.computeEfficiency/);
    expect(() => parseCalibration({ ...raw, status: 'guess' })).toThrow(/status/);
  });
});
