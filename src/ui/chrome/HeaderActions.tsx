// The sidebar header's actions (top right of the page): keyboard shortcuts, About, and the theme
// toggle. The shell overlays them on the sidebar's header row.

import { Button } from '../primitives/Button.tsx';
import type { ThemeName } from '../theme/colors.ts';
import { MoonIcon, SunIcon } from './icons.tsx';

export const SHORTCUTS_BUTTON_LABEL = 'Keyboard shortcuts (?)';

export interface HeaderActionsProps {
  theme: ThemeName;
  onToggleTheme: () => void;
  onShowShortcuts: () => void;
  onShowIntro: () => void;
}

export function HeaderActions({
  theme,
  onToggleTheme,
  onShowShortcuts,
  onShowIntro,
}: HeaderActionsProps) {
  const dark = theme === 'dark';
  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        aria-label={SHORTCUTS_BUTTON_LABEL}
        title={SHORTCUTS_BUTTON_LABEL}
        onClick={onShowShortcuts}
      >
        <kbd aria-hidden className="rounded border border-border-strong px-1 font-sans text-2xs">
          ?
        </kbd>
      </Button>
      <Button variant="ghost" size="sm" onClick={onShowIntro}>
        About
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Dark theme"
        title="Dark theme (d)"
        pressed={dark}
        onClick={onToggleTheme}
      >
        {dark ? <SunIcon /> : <MoonIcon />}
      </Button>
    </div>
  );
}
