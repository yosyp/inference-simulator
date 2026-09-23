// Random sources: one per kind of draw (02 §12, K6). The source is the second word of every keyed
// draw, so draws for different purposes never share values even when their keys match.
//
// Append only. The numbers are part of every simulated run: renumbering one changes the runs.
// A new kind of draw gets a new number here rather than reusing another source with an extra key.
//
// The keys listed are suggestions for the owning WP, not fixed here. Session and request ids are
// day-local, so keys that use them should include the day.

export const Source = {
  /** Session start time within the day. E6. Suggested keys: (day, analyst, index). */
  sessionStart: 1,
  /** Which analyst a session belongs to, if E6 assigns sessions to analysts by draw. */
  sessionAnalyst: 2,
  /** Keyed thinning uniform for loadMultiplier (TunableParams). E6. Keys: (day, candidate). */
  sessionThinning: 3,
  /** Turns per session (geometric). E6. Keys: (day, session). */
  turns: 4,
  /** New-message length (lognormal). E6. Keys: (day, session, turn). */
  messageLength: 5,
  /** Output length (lognormal). E6. Keys: (day, session, turn). */
  outputLength: 6,
  /** Think time before the next turn (log-logistic). E6. Keys: (day, session, turn). */
  thinkTime: 7,
  /** Retry backoff jitter. E6. Keys: (day, session, turn, attempt), stable across renumbering. */
  retryJitter: 8,
  /** Tie-breaks between equally good replicas. E7. Keys: (day, session, turn, attempt, kind), stable across retries. */
  routingTieBreak: 9,
  /** Failure timing or target. E8. Keys: (day, replica, incident). */
  failure: 10,
  /** Draws for injected extra requests, e.g. tab 1's long prompt. E6. */
  extraRequest: 11,
  /** Consistent-hash ring positions (with u32). E7. Keys: (replica, virtual node). */
  hashRing: 12,
  /** Session hash for affinity routing, mod-N or ring lookup (with u32). E7. Keys: (day, session). */
  sessionHash: 13,
  /** Seed-chosen tracked analyst (05 §5). Worker or scenario rule. */
  trackedAnalyst: 14,
  /** Thinning or timing for the loadSpike event. E6. */
  loadSpike: 15,
  /** Seeded workload generator for the differential oracle. E10. */
  oracleWorkload: 16,
} as const;

export type SourceName = keyof typeof Source;
export type Source = (typeof Source)[SourceName];
