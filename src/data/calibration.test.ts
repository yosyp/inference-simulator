import { describe, expect, it } from 'vitest';
import raw from '../../benchmarks/derived/calibration.json';
import provisional from '../../benchmarks/derived/calibration.provisional.json';
import measured from '../../benchmarks/derived/calibration.measured.json';
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

  it('ships the measured calibration', () => {
    expect(raw).toEqual(measured);
  });

  it('defaults the X4a cost terms to 0 and reads them from the measured file', () => {
    const c = parseCalibration(provisional).costModel;
    expect([c.decodePerSeqMs, c.cachedTokenMs, c.requestOverheadMs]).toEqual([0, 0, 0]);
    const m = parseCalibration(measured).costModel;
    expect(m.decodePerSeqMs).toBeGreaterThan(0);
    expect(m.cachedTokenMs).toBeGreaterThan(0);
    expect(m.requestOverheadMs).toBeGreaterThan(0);
    const bad = structuredClone(raw) as { costModel: Record<string, number> };
    bad.costModel.requestOverheadMs = -1;
    expect(() => parseCalibration(bad)).toThrow(/costModel\.requestOverheadMs/);
  });
});
