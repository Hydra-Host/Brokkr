import { Check, Monitor, Palette } from 'lucide-react';
import * as React from 'react';

import { Badge } from './badge';
import { Button } from './button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';
import { THEME_CATEGORIES, THEME_OPTIONS, useTheme } from './theme-provider';

export function ThemeSelector() {
  const { theme, mode, setTheme, setSystemMode, preferredDark, preferredLight } = useTheme();
  const current = THEME_OPTIONS.find((t) => t.value === theme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          {mode === 'system' ? (
            <Monitor className="h-4 w-4" style={{ color: current?.color }} />
          ) : (
            <Palette className="h-4 w-4" style={{ color: current?.color }} />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-48">
        <DropdownMenuItem onClick={setSystemMode} className="gap-3 font-mono text-xs">
          <Monitor className="h-3 w-3 shrink-0" />
          <div className="flex-1">
            <div className="flex items-center">
              System
              {mode === 'system' && <Check className="text-accent ml-auto h-3.5 w-3.5" />}
            </div>
            <div className="text-text-dim text-[10px] leading-tight">
              Switches between your preferred dark and light themes
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {THEME_CATEGORIES.map((category, i) => (
          <React.Fragment key={category.name}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="font-mono text-xs">{category.name}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {category.themes.map((option) => {
                const isPreferred = option.value === preferredDark || option.value === preferredLight;
                return (
                  <DropdownMenuItem
                    key={option.value}
                    onClick={() => setTheme(option.value)}
                    className="gap-3 font-mono text-xs"
                  >
                    <div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />
                    {option.label}
                    {(isPreferred || (mode !== 'system' && theme === option.value)) && (
                      <span className="ml-auto flex items-center gap-1.5">
                        {isPreferred && (
                          <Badge
                            variant="outline"
                            className="text-text-muted px-1 py-0 font-mono text-[9px] leading-tight"
                          >
                            preferred
                          </Badge>
                        )}
                        {mode !== 'system' && theme === option.value && <Check className="text-accent h-3.5 w-3.5" />}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
