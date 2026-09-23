// Legend glyphs drawn from the same encodings as the canvas (src/ui/theme/encodings.ts), so a
// legend or tooltip shows exactly what the canvas draws: color plus shape, size, dash, or hatching.

import { useId } from 'react';
import type { DotState } from '../../playback/types.ts';
import type { ReplicaStyleKey } from '../theme/encodings.ts';
import { dotStyles, kvTankStyle, replicaStyles } from '../theme/encodings.ts';

export interface DotGlyphProps {
  state: DotState;
  /** Box size in px. The mark itself keeps its canvas size. */
  size?: number;
  /** Accessible name; omit when a visible label sits next to the glyph. */
  title?: string;
}

export function DotGlyph({ state, size = 12, title }: DotGlyphProps) {
  const s = dotStyles[state];
  const r = s.radiusPx;
  const common = {
    fill: s.fill ?? 'none',
    stroke: s.stroke,
    strokeWidth: s.strokeWidthPx,
  };
  const h = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-h} ${-h} ${size} ${size}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-shape={s.shape}
    >
      {s.shape === 'diamond' ? (
        <path d={`M0 ${-r}L${r} 0L0 ${r}L${-r} 0Z`} {...common} />
      ) : (
        <circle r={r} {...common} />
      )}
    </svg>
  );
}

export interface ReplicaGlyphProps {
  state: ReplicaStyleKey;
  width?: number;
  height?: number;
  /** 0..1, shown as a progress bar in loading states. */
  progress?: number;
  title?: string;
}

export function ReplicaGlyph({
  state,
  width = 28,
  height = 18,
  progress = 0.6,
  title,
}: ReplicaGlyphProps) {
  const s = replicaStyles[state];
  const patternId = useId();
  const inset = s.strokeWidthPx / 2;
  const w = width - s.strokeWidthPx;
  const h = height - s.strokeWidthPx;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-state={state}
    >
      {s.hatch && (
        <defs>
          <pattern
            id={patternId}
            width={s.hatch.spacingPx}
            height={s.hatch.spacingPx}
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line
              x1="0"
              y1="0"
              x2="0"
              y2={s.hatch.spacingPx}
              stroke={s.hatch.color}
              strokeWidth={s.hatch.widthPx}
            />
          </pattern>
        </defs>
      )}
      <rect x={inset} y={inset} width={w} height={h} rx="2" fill={s.fill} />
      {s.hatch && (
        <rect x={inset} y={inset} width={w} height={h} rx="2" fill={`url(#${patternId})`} />
      )}
      {s.showsTank && !s.progress && (
        <rect
          x={width - 8}
          y={4}
          width={4}
          height={height - 8}
          fill={kvTankStyle.fill}
          stroke={kvTankStyle.stroke}
          strokeWidth={0.5}
        />
      )}
      {s.progress && (
        <>
          <rect x={4} y={height - 7} width={width - 8} height={3} fill={s.progress.track} />
          <rect
            x={4}
            y={height - 7}
            width={(width - 8) * Math.min(1, Math.max(0, progress))}
            height={3}
            fill={s.progress.fill}
          />
        </>
      )}
      <rect
        x={inset}
        y={inset}
        width={w}
        height={h}
        rx="2"
        fill="none"
        stroke={s.stroke}
        strokeWidth={s.strokeWidthPx}
        strokeDasharray={s.dash.length ? s.dash.join(' ') : undefined}
      />
    </svg>
  );
}
