import type { Calibration } from '../../engine/calibration.ts';
import type { Preset } from '../../scenarios/schema.ts';
import { Badge } from '../primitives/Badge.tsx';
import { cx } from '../primitives/util.ts';
import { footnoteText } from './footnote.ts';

export interface FootnoteProps {
  calibration: Calibration;
  /** The tab's preset; an extrapolated preset adds a line saying so. */
  preset?: Preset;
  className?: string;
}

export function Footnote({ calibration, preset, className }: FootnoteProps) {
  const { provisional, lines } = footnoteText(calibration, preset);
  return (
    <footer className={cx('flex flex-col gap-1 border-t border-border pt-3', className)}>
      {provisional && (
        <Badge tone="warn" className="self-start">
          Provisional calibration
        </Badge>
      )}
      {lines.map((line) => (
        <p key={line} className="text-2xs text-ink-subtle">
          {line}
        </p>
      ))}
    </footer>
  );
}
