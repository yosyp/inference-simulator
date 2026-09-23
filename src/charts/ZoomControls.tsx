// Zoom out, zoom in, and reset for the shared chart window.

import { Button, cx } from '../ui/primitives/index.ts';

export interface ZoomControlsProps {
  canIn: boolean;
  canOut: boolean;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
  className?: string;
}

const small = 'h-6 min-w-6 px-1.5 text-xs';

export function ZoomControls({
  canIn,
  canOut,
  onIn,
  onOut,
  onReset,
  className,
}: ZoomControlsProps) {
  return (
    <div role="group" aria-label="Chart zoom" className={cx('flex items-center gap-1', className)}>
      <Button
        variant="ghost"
        size="sm"
        className={small}
        aria-label="Zoom out"
        disabled={!canOut}
        onClick={onOut}
      >
        −
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={small}
        aria-label="Zoom in"
        disabled={!canIn}
        onClick={onIn}
      >
        +
      </Button>
      <Button variant="ghost" size="sm" className={small} disabled={!canOut} onClick={onReset}>
        Shift day
      </Button>
    </div>
  );
}
