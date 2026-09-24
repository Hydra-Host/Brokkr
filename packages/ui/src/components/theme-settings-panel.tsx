import { Check } from 'lucide-react';

import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './card';
import { THEME_COLORS, THEME_MODES, THEME_STYLES, useTheme } from './theme-provider';
import { ThemeScope } from './theme-scope';
import { cn } from './utils';

function StylePreview() {
  return (
    <div className="bg-bg-primary border-border-dim pointer-events-none w-full rounded-md border p-3 text-left">
      <div className="flex items-center gap-2">
        <span className="bg-accent h-2 w-2 rounded-full" />
        <span className="bg-text-muted h-1.5 w-12 rounded-sm" />
      </div>
      <div className="bg-card border-border-dim mt-2 rounded-md border p-2">
        <div className="bg-text-dim h-1.5 w-16 rounded-sm" />
        <div className="bg-border-dim mt-1.5 h-1.5 w-10 rounded-sm" />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="bg-accent text-accent-foreground rounded-sm px-2 py-0.5 font-mono text-[9px]">OK</span>
        <span className="border-border-dim text-text-dim rounded-sm border px-2 py-0.5 font-mono text-[9px]">…</span>
      </div>
    </div>
  );
}

export function ThemeSettingsPanel() {
  const { style, color, modePreference, resolvedMode, setStyle, setColor, setMode } = useTheme();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Mode</CardTitle>
          <CardDescription>Dark, light, or follow your OS appearance</CardDescription>
          <CardAction>
            <div
              role="group"
              aria-label="Mode"
              className="border-border-dim divide-border-dim flex divide-x overflow-hidden rounded-md border"
            >
              {THEME_MODES.map((option) => {
                const Icon = option.icon;
                const active = modePreference === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMode(option.value)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 font-mono text-xs transition-colors',
                      active ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-hover-bg',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </CardAction>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Style</CardTitle>
          <CardDescription>How the interface is drawn — chrome, corners, and type</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="group" aria-label="Style" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {THEME_STYLES.map((option) => {
              const active = style === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setStyle(option.value)}
                  className={cn(
                    'relative flex flex-col gap-3 rounded-sm border p-4 text-left transition-all',
                    active ? 'border-accent' : 'border-border-dim hover:border-text-muted',
                  )}
                >
                  {active && <Check className="text-accent absolute top-3 right-3 h-4 w-4" />}
                  <ThemeScope style={option.value} color={color} mode={resolvedMode} className="w-full">
                    <StylePreview />
                  </ThemeScope>
                  <div>
                    <div className={cn('font-mono text-sm font-medium', active && 'text-accent')}>{option.label}</div>
                    <div className="text-text-dim text-xs">{option.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Color</CardTitle>
          <CardDescription>The accent color, carried through the whole theme</CardDescription>
        </CardHeader>
        <CardContent>
          <div role="group" aria-label="Color" className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {THEME_COLORS.map((option) => {
              const active = color === option.value;
              const swatch = resolvedMode === 'dark' ? option.swatchDark : option.swatchLight;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setColor(option.value)}
                  className={cn(
                    'relative flex flex-col items-center gap-3 rounded-sm border p-6 transition-all',
                    active ? 'border-accent' : 'border-border hover:border-text-muted',
                  )}
                  style={{ backgroundColor: active ? `${swatch}15` : undefined }}
                >
                  {active && <Check className="text-accent absolute top-2 right-2 h-3.5 w-3.5" />}
                  <div className="h-10 w-10" style={{ backgroundColor: swatch, boxShadow: `0 0 16px ${swatch}60` }} />
                  <span className="font-mono text-sm font-medium" style={{ color: active ? swatch : undefined }}>
                    {option.label}
                  </span>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <p className="text-text-muted text-sm">This setting is stored locally in your browser.</p>
    </div>
  );
}
