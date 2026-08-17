import { Check, Palette } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

import { Button } from './button';
import { cn } from './utils';

export type Theme = 'hydra-dark' | 'yellow' | 'blue' | 'green' | 'pink' | 'hydra-light' | 'solarized-light';

export interface ThemeOption {
  value: Theme;
  label: string;
  color: string;
  group: 'Dark' | 'Light';
}

export const THEME_OPTIONS: ThemeOption[] = [
  { value: 'hydra-dark', label: 'Hydra Dark', color: '#ECEAFF', group: 'Dark' },
  { value: 'yellow', label: 'Gold', color: '#FFDC75', group: 'Dark' },
  { value: 'blue', label: 'Blue', color: '#6BC1FF', group: 'Dark' },
  { value: 'green', label: 'Green', color: '#53FF99', group: 'Dark' },
  { value: 'pink', label: 'Pink', color: '#FFAAF1', group: 'Dark' },
  { value: 'hydra-light', label: 'Hydra Light', color: '#5554FF', group: 'Light' },
  { value: 'solarized-light', label: 'Solarized', color: '#2AA198', group: 'Light' },
];

const STORAGE_KEY = 'lab-theme';
const DEFAULT_THEME: Theme = 'hydra-dark';
const VALID = new Set<string>(THEME_OPTIONS.map((t) => t.value));

function readStored(): Theme {
  const fromUrl = new URLSearchParams(window.location.search).get('theme');
  if (fromUrl && VALID.has(fromUrl)) return fromUrl as Theme;
  const v = localStorage.getItem(STORAGE_KEY);
  return v && VALID.has(v) ? (v as Theme) : DEFAULT_THEME;
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStored);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = THEME_OPTIONS.find((t) => t.value === theme);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const groups: ThemeOption['group'][] = ['Dark', 'Light'];

  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((o) => !o)}
        className="h-8 w-8"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Theme"
        title="Theme"
      >
        <Palette className="h-4 w-4" style={{ color: current?.color }} />
      </Button>
      {open && (
        <div
          role="menu"
          className="border-border-dim bg-bg-secondary absolute right-0 z-50 mt-1 w-52 rounded-sm border p-1 font-mono shadow-xl"
        >
          {groups.map((g, gi) => (
            <div key={g}>
              {gi > 0 && <div className="bg-border-dim my-1 h-px" />}
              <div className="text-text-label px-2 py-1 text-[10px] tracking-widest uppercase">{g}</div>
              {THEME_OPTIONS.filter((t) => t.group === g).map((opt) => (
                <button
                  key={opt.value}
                  role="menuitemradio"
                  aria-checked={theme === opt.value}
                  onClick={() => {
                    setTheme(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-xs transition-colors',
                    theme === opt.value
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-muted hover:bg-hover-bg hover:text-text-primary',
                  )}
                >
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: opt.color }} />
                  {opt.label}
                  {theme === opt.value && <Check className="text-accent ml-auto h-3.5 w-3.5" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
