import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  THEME_COLOR_VALUES,
  THEME_MODE_VALUES,
  THEME_STYLE_VALUES,
  type ModePreference,
  type ResolvedMode,
  type ThemeColor,
  type ThemeStyle,
} from '../lib/theme-axes';

export type { ModePreference, ResolvedMode, ThemeColor, ThemeStyle };

export interface ThemeStyleOption {
  value: ThemeStyle;
  label: string;
  description: string;
}

export interface ThemeColorOption {
  value: ThemeColor;
  label: string;
  swatchDark: string;
  swatchLight: string;
}

export interface ThemeModeOption {
  value: ModePreference;
  label: string;
  icon: LucideIcon;
}

const STYLE_META: Record<ThemeStyle, Omit<ThemeStyleOption, 'value'>> = {
  retro: { label: 'Retro', description: 'Square, techy, monospace' },
  modern: { label: 'Modern', description: 'Rounded, calm, sans-serif' },
};

const COLOR_META: Record<ThemeColor, Omit<ThemeColorOption, 'value'>> = {
  violet: { label: 'Violet', swatchDark: '#857cff', swatchLight: '#635bff' },
  blue: { label: 'Blue', swatchDark: '#6bc1ff', swatchLight: '#2563eb' },
  green: { label: 'Green', swatchDark: '#53ff99', swatchLight: '#15803d' },
  pink: { label: 'Pink', swatchDark: '#ffaaf1', swatchLight: '#a21caf' },
  gold: { label: 'Gold', swatchDark: '#ffdc75', swatchLight: '#a16207' },
};

export const THEME_STYLES: ThemeStyleOption[] = THEME_STYLE_VALUES.map((value) => ({ value, ...STYLE_META[value] }));
export const THEME_COLORS: ThemeColorOption[] = THEME_COLOR_VALUES.map((value) => ({ value, ...COLOR_META[value] }));
export const THEME_MODES: ThemeModeOption[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const STYLE_SET = new Set<string>(THEME_STYLE_VALUES);
const COLOR_SET = new Set<string>(THEME_COLOR_VALUES);
const MODE_SET = new Set<string>(THEME_MODE_VALUES);

export const STORAGE_KEYS = {
  STYLE: 'brokkr-style',
  COLOR: 'brokkr-color',
  MODE: 'brokkr-mode',
} as const;

export const LEGACY_STORAGE_KEYS = [
  'brokkr-theme',
  'brokkr-preferred-dark',
  'brokkr-preferred-light',
  'brokkr-preset',
] as const;

export interface Axes {
  style: ThemeStyle;
  color: ThemeColor;
  mode: ResolvedMode;
}

/* Pre-axis theme ids (plus their own older aliases) mapped onto the axes. */
export const LEGACY_THEME_AXES: Record<string, Axes> = {
  'hydra-dark': { style: 'retro', color: 'violet', mode: 'dark' },
  violet: { style: 'retro', color: 'violet', mode: 'dark' },
  cyan: { style: 'retro', color: 'violet', mode: 'dark' },
  yellow: { style: 'retro', color: 'gold', mode: 'dark' },
  blue: { style: 'retro', color: 'blue', mode: 'dark' },
  green: { style: 'retro', color: 'green', mode: 'dark' },
  pink: { style: 'retro', color: 'pink', mode: 'dark' },
  'hydra-light': { style: 'retro', color: 'violet', mode: 'light' },
  'atom-light': { style: 'retro', color: 'violet', mode: 'light' },
  'solarized-light': { style: 'retro', color: 'violet', mode: 'light' },
  'commerce-dark': { style: 'modern', color: 'violet', mode: 'dark' },
  'commerce-light': { style: 'modern', color: 'violet', mode: 'light' },
};

export interface Preferences {
  style: ThemeStyle;
  color: ThemeColor;
  mode: ModePreference;
}

function read<T extends string>(key: string, valid: Set<string>): T | null {
  const value = localStorage.getItem(key);
  return value && valid.has(value) ? (value as T) : null;
}

function prefersLight(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function migrateLegacyPreferences(): Preferences | null {
  const stored = localStorage.getItem('brokkr-theme');
  if (!stored) return null;
  /* Old 'system' mode carried a preferred theme per OS side; derive the new
     axes from the side the user is currently looking at. */
  const preferredKey = prefersLight() ? 'brokkr-preferred-light' : 'brokkr-preferred-dark';
  const legacyTheme = stored === 'system' ? (localStorage.getItem(preferredKey) ?? 'hydra-dark') : stored;
  const axes = LEGACY_THEME_AXES[legacyTheme];
  if (!axes) return null;
  return {
    style: axes.style,
    color: axes.color,
    mode: stored === 'system' ? 'system' : axes.mode,
  };
}

function readColor(): ThemeColor | null {
  const value = localStorage.getItem(STORAGE_KEYS.COLOR);
  return value && COLOR_SET.has(value) ? (value as ThemeColor) : null;
}

export function loadPreferences(defaults: Preferences): Preferences {
  const style = read<ThemeStyle>(STORAGE_KEYS.STYLE, STYLE_SET);
  const color = readColor();
  const mode = read<ModePreference>(STORAGE_KEYS.MODE, MODE_SET);
  const legacy = !style && !color && !mode ? migrateLegacyPreferences() : null;
  for (const key of LEGACY_STORAGE_KEYS) localStorage.removeItem(key);
  const prefs = {
    style: style ?? legacy?.style ?? defaults.style,
    color: color ?? legacy?.color ?? defaults.color,
    mode: mode ?? legacy?.mode ?? defaults.mode,
  };
  /* Migrated choices are re-persisted (explicit once). Defaults are not, so a
     deployment can change its default and returning visitors still follow it. */
  if (legacy) persistAll(prefs);
  return prefs;
}

function persistAll(prefs: Preferences) {
  localStorage.setItem(STORAGE_KEYS.STYLE, prefs.style);
  localStorage.setItem(STORAGE_KEYS.COLOR, prefs.color);
  localStorage.setItem(STORAGE_KEYS.MODE, prefs.mode);
}

function resolveAxes(prefs: Preferences, systemIsLight: boolean): Axes {
  const mode = prefs.mode === 'system' ? (systemIsLight ? 'light' : 'dark') : prefs.mode;
  return { style: prefs.style, color: prefs.color, mode };
}

function applyToDOM(axes: Axes) {
  const el = document.documentElement;
  el.setAttribute('data-style', axes.style);
  el.setAttribute('data-color', axes.color);
  el.setAttribute('data-mode', axes.mode);
  el.removeAttribute('data-preset');
  el.removeAttribute('data-theme');
}

interface ThemeContextValue {
  style: ThemeStyle;
  color: ThemeColor;
  modePreference: ModePreference;
  resolvedMode: ResolvedMode;
  setStyle: (style: ThemeStyle) => void;
  setColor: (color: ThemeColor) => void;
  setMode: (mode: ModePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({
  children,
  defaultStyle = 'retro',
  defaultColor = 'violet',
  defaultMode = 'dark',
}: {
  children: React.ReactNode;
  defaultStyle?: ThemeStyle;
  defaultColor?: ThemeColor;
  defaultMode?: ModePreference;
}) {
  const [prefs, setPrefs] = useState(() =>
    loadPreferences({ style: defaultStyle, color: defaultColor, mode: defaultMode }),
  );
  const [systemIsLight, setSystemIsLight] = useState(prefersLight);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => setSystemIsLight(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const axes = useMemo(() => resolveAxes(prefs, systemIsLight), [prefs, systemIsLight]);

  useEffect(() => {
    applyToDOM(axes);
  }, [axes]);

  /* Persist only on explicit user action — see loadPreferences. */
  const setStyle = useCallback((style: ThemeStyle) => {
    setPrefs((prev) => {
      const next = { ...prev, style };
      persistAll(next);
      return next;
    });
  }, []);

  const setColor = useCallback((color: ThemeColor) => {
    setPrefs((prev) => {
      const next = { ...prev, color };
      persistAll(next);
      return next;
    });
  }, []);

  const setMode = useCallback((mode: ModePreference) => {
    setPrefs((prev) => {
      const next = { ...prev, mode };
      persistAll(next);
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      style: prefs.style,
      color: prefs.color,
      modePreference: prefs.mode,
      resolvedMode: axes.mode,
      setStyle,
      setColor,
      setMode,
    }),
    [prefs, axes.mode, setStyle, setColor, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
