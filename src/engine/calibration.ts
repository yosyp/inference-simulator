// Calibration inputs (03-benchmarks §8, K10). The engine receives a Calibration as a parameter;
// src/data/calibration.ts loads benchmarks/derived/calibration.json and validates it with parseCalibration.

export type ColdStartCondition = 'processRestart' | 'hostReboot' | 'replacementHost';

/** Milliseconds from process start to each phase. */
export interface ColdStartPhases {
  weightsLoaded: number;
  engineReady: number;
}

export interface Calibration {
  schemaVersion: 1;
  /** 'provisional' until benchmarks R0–R8 land; the app footnote says so (05 §8). */
  status: 'provisional' | 'measured';
  source: { runIds: string[]; vllm: string; gpu: string; powerLimitW: number };
  /** Spec-sheet GPU constants (02 §2). */
  gpu: {
    peakDenseFp16Flops: number;
    memoryBandwidthBytesPerSecond: number;
    memoryBytes: number;
  };
  model: {
    name: string;
    dtype: string;
    params: number;
    weightBytes: number;
    layers: number;
    /** Query hidden size (heads × head dim); attention FLOPs per token per attended token ≈ 4 × layers × hiddenSize. */
    hiddenSize: number;
    kvHeads: number;
    headDim: number;
    kvBytesPerToken: number;
  };
  engine: {
    kvPoolTokens: number;
    blockSize: number;
    maxNumSeqs: number;
    maxNumBatchedTokens: number;
    maxModelLen: number;
  };
  /** Roofline calibration (02 §6): η_c, η_b, t_o. */
  costModel: {
    computeEfficiency: number;
    bandwidthEfficiency: number;
    stepOverheadMs: number;
  };
  coldStartMs: Record<ColdStartCondition, ColdStartPhases>;
  /** Informational (R6); null until measured. */
  prefixCache: {
    warmTtftMs: number | null;
    coldTtftMs: number | null;
    prefixTokens: number | null;
  };
}

function fail(path: string, expected: string): never {
  throw new Error(`Invalid calibration: ${path} should be ${expected}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'an object');
  return v as Record<string, unknown>;
}

function pos(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
    fail(`${path}.${key}`, 'a positive number');
  return v;
}

function str(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) fail(`${path}.${key}`, 'a non-empty string');
  return v;
}

function optNum(o: Record<string, unknown>, key: string, path: string): number | null {
  const v = o[key];
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path}.${key}`, 'a number or null');
  return v;
}

function fraction(o: Record<string, unknown>, key: string, path: string): number {
  const v = pos(o, key, path);
  if (v > 1) fail(`${path}.${key}`, 'at most 1');
  return v;
}

/** Validates untrusted JSON into a Calibration. Throws with the offending path on failure. */
export function parseCalibration(json: unknown): Calibration {
  const root = obj(json, 'calibration');
  if (root.schemaVersion !== 1) fail('schemaVersion', '1');
  if (root.status !== 'provisional' && root.status !== 'measured') {
    fail('status', "'provisional' or 'measured'");
  }
  const source = obj(root.source, 'source');
  const runIds = source.runIds;
  if (!Array.isArray(runIds) || !runIds.every((r) => typeof r === 'string')) {
    fail('source.runIds', 'an array of strings');
  }
  const gpu = obj(root.gpu, 'gpu');
  const model = obj(root.model, 'model');
  const engine = obj(root.engine, 'engine');
  const cost = obj(root.costModel, 'costModel');
  const cold = obj(root.coldStartMs, 'coldStartMs');
  const prefix = obj(root.prefixCache, 'prefixCache');

  const phases = (key: ColdStartCondition): ColdStartPhases => {
    const p = obj(cold[key], `coldStartMs.${key}`);
    const weightsLoaded = pos(p, 'weightsLoaded', `coldStartMs.${key}`);
    const engineReady = pos(p, 'engineReady', `coldStartMs.${key}`);
    if (engineReady < weightsLoaded) fail(`coldStartMs.${key}.engineReady`, '>= weightsLoaded');
    return { weightsLoaded, engineReady };
  };

  const calibration: Calibration = {
    schemaVersion: 1,
    status: root.status,
    source: {
      runIds: runIds as string[],
      vllm: str(source, 'vllm', 'source'),
      gpu: str(source, 'gpu', 'source'),
      powerLimitW: pos(source, 'powerLimitW', 'source'),
    },
    gpu: {
      peakDenseFp16Flops: pos(gpu, 'peakDenseFp16Flops', 'gpu'),
      memoryBandwidthBytesPerSecond: pos(gpu, 'memoryBandwidthBytesPerSecond', 'gpu'),
      memoryBytes: pos(gpu, 'memoryBytes', 'gpu'),
    },
    model: {
      name: str(model, 'name', 'model'),
      dtype: str(model, 'dtype', 'model'),
      params: pos(model, 'params', 'model'),
      weightBytes: pos(model, 'weightBytes', 'model'),
      layers: pos(model, 'layers', 'model'),
      hiddenSize: pos(model, 'hiddenSize', 'model'),
      kvHeads: pos(model, 'kvHeads', 'model'),
      headDim: pos(model, 'headDim', 'model'),
      kvBytesPerToken: pos(model, 'kvBytesPerToken', 'model'),
    },
    engine: {
      kvPoolTokens: pos(engine, 'kvPoolTokens', 'engine'),
      blockSize: pos(engine, 'blockSize', 'engine'),
      maxNumSeqs: pos(engine, 'maxNumSeqs', 'engine'),
      maxNumBatchedTokens: pos(engine, 'maxNumBatchedTokens', 'engine'),
      maxModelLen: pos(engine, 'maxModelLen', 'engine'),
    },
    costModel: {
      computeEfficiency: fraction(cost, 'computeEfficiency', 'costModel'),
      bandwidthEfficiency: fraction(cost, 'bandwidthEfficiency', 'costModel'),
      stepOverheadMs: pos(cost, 'stepOverheadMs', 'costModel'),
    },
    coldStartMs: {
      processRestart: phases('processRestart'),
      hostReboot: phases('hostReboot'),
      replacementHost: phases('replacementHost'),
    },
    prefixCache: {
      warmTtftMs: optNum(prefix, 'warmTtftMs', 'prefixCache'),
      coldTtftMs: optNum(prefix, 'coldTtftMs', 'prefixCache'),
      prefixTokens: optNum(prefix, 'prefixTokens', 'prefixCache'),
    },
  };
  if (calibration.engine.kvPoolTokens % calibration.engine.blockSize !== 0) {
    // Not fatal in vLLM, but the block pool is kvPoolTokens / blockSize; keep it exact.
    fail('engine.kvPoolTokens', 'a multiple of engine.blockSize');
  }
  return calibration;
}
