import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Theme = 'hydra-dark' | 'yellow' | 'blue' | 'green' | 'pink' | 'hydra-light' | 'solarized-light';
export type ThemeMode = Theme | 'system';

export interface ThemeOption {
  value: Theme;
  label: string;
  color: string;
}

export interface ThemeCategory {
  name: string;
  description?: string;
  themes: ThemeOption[];
}

export const DARK_THEMES: ThemeOption[] = [
  { value: 'hydra-dark', label: 'Violet', color: '#ECEAFF' },
  { value: 'yellow', label: 'Gold', color: '#FFDC75' },
  { value: 'blue', label: 'Blue', color: '#6BC1FF' },
  { value: 'green', label: 'Green', color: '#53FF99' },
  { value: 'pink', label: 'Pink', color: '#FFAAF1' },
];

export const LIGHT_THEMES: ThemeOption[] = [
  { value: 'hydra-light', label: 'Violet', color: '#5554FF' },
  { value: 'solarized-light', label: 'Solar', color: '#2AA198' },
];

export const THEME_OPTIONS: ThemeOption[] = [...DARK_THEMES, ...LIGHT_THEMES];

export const THEME_CATEGORIES: ThemeCategory[] = [
  { name: 'Dark', themes: DARK_THEMES },
  { name: 'Light', themes: LIGHT_THEMES },
];

const DARK_SET = new Set<string>(DARK_THEMES.map((t) => t.value));
const LIGHT_SET = new Set<string>(LIGHT_THEMES.map((t) => t.value));
const VALID_MODES = new Set<string>([...DARK_SET, ...LIGHT_SET, 'system']);

const DEFAULT_DARK: Theme = 'hydra-dark';
const DEFAULT_LIGHT: Theme = 'hydra-light';

export const isDarkTheme = (theme: Theme) => DARK_SET.has(theme);
export const isLightTheme = (theme: Theme) => LIGHT_SET.has(theme);

const STORAGE_KEYS = {
  MODE: 'brokkr-theme',
  PREFERRED_DARK: 'brokkr-preferred-dark',
  PREFERRED_LIGHT: 'brokkr-preferred-light',
} as const;

const LEGACY_MIGRATIONS: Record<string, string> = {
  violet: 'hydra-dark',
  'atom-light': 'hydra-light',
  cyan: 'hydra-dark',
};

function read<T extends string>(key: string, valid: Set<string>, fallback: T): T {
  let value = localStorage.getItem(key);
  if (value && LEGACY_MIGRATIONS[value]) value = LEGACY_MIGRATIONS[value];
  return value && valid.has(value) ? (value as T) : fallback;
}

function persistAll(mode: ThemeMode, dark: Theme, light: Theme) {
  localStorage.setItem(STORAGE_KEYS.MODE, mode);
  localStorage.setItem(STORAGE_KEYS.PREFERRED_DARK, dark);
  localStorage.setItem(STORAGE_KEYS.PREFERRED_LIGHT, light);
}

function applyToDOM(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

interface ThemeContextValue {
  theme: Theme;
  mode: ThemeMode;
  setTheme: (theme: Theme) => void;
  setSystemMode: () => void;
  preferredDark: Theme;
  preferredLight: Theme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

interface Preferences {
  mode: ThemeMode;
  preferredDark: Theme;
  preferredLight: Theme;
}

function loadPreferences(): Preferences {
  return {
    mode: read<ThemeMode>(STORAGE_KEYS.MODE, VALID_MODES, DEFAULT_DARK),
    preferredDark: read<Theme>(STORAGE_KEYS.PREFERRED_DARK, DARK_SET, DEFAULT_DARK),
    preferredLight: read<Theme>(STORAGE_KEYS.PREFERRED_LIGHT, LIGHT_SET, DEFAULT_LIGHT),
  };
}

function resolveTheme(prefs: Preferences, systemIsLight: boolean): Theme {
  if (prefs.mode !== 'system') return prefs.mode;
  return systemIsLight ? prefs.preferredLight : prefs.preferredDark;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState(loadPreferences);
  const [systemIsLight, setSystemIsLight] = useState(() => window.matchMedia('(prefers-color-scheme: light)').matches);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => setSystemIsLight(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const theme = useMemo(() => resolveTheme(prefs, systemIsLight), [prefs, systemIsLight]);

  useEffect(() => {
    applyToDOM(theme);
    persistAll(prefs.mode, prefs.preferredDark, prefs.preferredLight);
  }, [theme, prefs]);

  const setTheme = useCallback((t: Theme) => {
    setPrefs((prev) => ({
      mode: t,
      preferredDark: isDarkTheme(t) ? t : prev.preferredDark,
      preferredLight: isLightTheme(t) ? t : prev.preferredLight,
    }));
  }, []);

  const setSystemMode = useCallback(() => {
    setPrefs((prev) => ({ ...prev, mode: 'system' }));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode: prefs.mode,
      setTheme,
      setSystemMode,
      preferredDark: prefs.preferredDark,
      preferredLight: prefs.preferredLight,
    }),
    [theme, prefs, setTheme, setSystemMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
