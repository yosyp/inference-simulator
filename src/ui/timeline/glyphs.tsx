// Timeline marker glyphs (K26): neutral ink plus a shape, from markerStyles in the theme, so a
// marker never relies on hue. All are decorative; the controls that carry them have names.

import { cssVar } from '../theme/colors.ts';
import { markerStyles } from '../theme/encodings.ts';

/** Lesson moment: a downward triangle with an ink edge, pointing at the bar. */
export function LessonGlyph() {
  return (
    <svg width="11" height="9" viewBox="0 0 11 9" aria-hidden data-glyph="triangle">
      <path
        d="M0.75 0.75H10.25L5.5 8.25Z"
        fill={markerStyles.incident.color}
        stroke={markerStyles.incident.glyphStroke}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Fork: a small flag on a pole. */
export function ForkGlyph() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden data-glyph="flag">
      <path d="M1.5 0.5V9.5" stroke={markerStyles.fork.color} strokeWidth="1.25" />
      <path d="M1.5 0.75L8.25 3L1.5 5.25Z" fill={markerStyles.fork.color} />
    </svg>
  );
}

/** Playhead handle: a knob on the computed strip. Hollow while the playhead waits (buffering). */
export function PlayheadHandle({ hollow }: { hollow: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden data-glyph="handle">
      <circle
        cx="5.5"
        cy="5.5"
        r="4.5"
        fill={hollow ? cssVar('surface') : markerStyles.playhead.color}
        stroke={markerStyles.playhead.color}
        strokeWidth={markerStyles.playhead.widthPx}
      />
    </svg>
  );
}
