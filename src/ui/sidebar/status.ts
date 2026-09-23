// Live status line templates (05 §8): each scenario's templates are evaluated against the engine's
// StatusSnapshot at the playhead, and the highest-priority one that applies wins.

import type { StatusSnapshot } from '../../playback/types.ts';
import type { StatusTemplate } from '../../scenarios/schema.ts';

export interface StatusResult {
  id: string;
  text: string;
}

/** Highest priority first; templates with equal priority keep their listed order. */
export function byPriority(templates: readonly StatusTemplate[]): StatusTemplate[] {
  return [...templates].sort((a, b) => b.priority - a.priority);
}

/**
 * The status line for a snapshot: the highest-priority template that returns text, or null when
 * none applies. Ties go to the template listed first. A template that throws is reported and
 * skipped, so one bad template cannot take down the sidebar.
 */
export function evaluateStatus(
  templates: readonly StatusTemplate[],
  snapshot: StatusSnapshot,
  sorted = false,
): StatusResult | null {
  for (const t of sorted ? templates : byPriority(templates)) {
    let text: string | null;
    try {
      text = t.render(snapshot);
    } catch (err) {
      console.error(`Status template "${t.id}" failed:`, err);
      continue;
    }
    if (text !== null && text.trim() !== '') return { id: t.id, text };
  }
  return null;
}
