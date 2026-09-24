import { Check, Monitor, Palette } from 'lucide-react';

import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { THEME_COLORS, THEME_MODES, THEME_STYLES, useTheme } from './theme-provider';
import { cn } from './utils';

export function ThemeSelector() {
  const { style, color, modePreference, resolvedMode, setStyle, setColor, setMode } = useTheme();
  const colorOptions = THEME_COLORS;
  const currentColor = colorOptions.find((c) => c.value === color);
  const swatch = resolvedMode === 'dark' ? currentColor?.swatchDark : currentColor?.swatchLight;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          {modePreference === 'system' ? (
            <Monitor className="h-4 w-4" style={{ color: swatch }} />
          ) : (
            <Palette className="h-4 w-4" style={{ color: swatch }} />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-56">
        <DropdownMenuLabel className="font-mono text-xs">Mode</DropdownMenuLabel>
        <div className="flex gap-1 px-2 pb-1.5">
          {THEME_MODES.map((item) => {
            const Icon = item.icon;
            const active = modePreference === item.value;
            return (
              <DropdownMenuItem
                key={item.value}
                closeOnClick={false}
                onClick={() => setMode(item.value)}
                className={cn(
                  'flex-1 justify-center gap-1.5 border px-2 py-1.5 font-mono text-[10px]',
                  active ? 'border-accent text-accent' : 'border-border-dim text-text-muted',
                )}
              >
                <Icon className="h-3 w-3 shrink-0" />
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-mono text-xs">Style</DropdownMenuLabel>
        {THEME_STYLES.map((option) => (
          <DropdownMenuItem
            key={option.value}
            closeOnClick={false}
            onClick={() => setStyle(option.value)}
            className="gap-3 font-mono text-xs"
          >
            <div className="flex-1">
              <div className="flex items-center">
                {option.label}
                {style === option.value && <Check className="text-accent ml-auto h-3.5 w-3.5" />}
              </div>
              <div className="text-text-dim text-[10px] leading-tight">{option.description}</div>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-mono text-xs">Color</DropdownMenuLabel>
        <div className="flex px-2 pb-1.5">
          {colorOptions.map((option) => {
            const optionSwatch = resolvedMode === 'dark' ? option.swatchDark : option.swatchLight;
            const active = color === option.value;
            return (
              <DropdownMenuItem
                key={option.value}
                closeOnClick={false}
                onClick={() => setColor(option.value)}
                title={option.label}
                className="flex-1 justify-center p-0"
              >
                <span
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-full border',
                    active ? 'border-accent' : 'border-transparent',
                  )}
                >
                  <span className="h-4 w-4 rounded-full" style={{ backgroundColor: optionSwatch }} />
                </span>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
