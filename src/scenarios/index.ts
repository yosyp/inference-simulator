// The scenario registry (X1): the six tabs in teaching order. Tabs not yet written by C2/C3 fall
// back to the placeholder fixtures.

import { fixtureScenarios } from '../fixtures/scenarios.ts';
import type { Scenario } from './schema.ts';
import { scenario as longPrompt } from './tab1-long-prompt/index.ts';
import { scenario as knee } from './tab2-knee/index.ts';

const written: readonly Scenario[] = [longPrompt, knee];

export function scenarios(): Scenario[] {
  const byId = new Map(fixtureScenarios().map((s) => [s.id, s]));
  for (const s of written) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => a.tab - b.tab);
}
