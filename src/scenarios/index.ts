// The scenario registry: the six tabs in teaching order (01 §6).

import type { Scenario } from './schema.ts';
import { scenario as longPrompt } from './tab1-long-prompt/index.ts';
import { scenario as knee } from './tab2-knee/index.ts';
import { scenario as kvExhaustion } from './tab3-kv/index.ts';
import { scenario as routing } from './tab4-routing/index.ts';
import { scenario as failRecover } from './tab5-fail-recover/index.ts';
import { scenario as retryStorm } from './tab6-retry-storm/index.ts';

export function scenarios(): Scenario[] {
  return [longPrompt, knee, kvExhaustion, routing, failRecover, retryStorm];
}
