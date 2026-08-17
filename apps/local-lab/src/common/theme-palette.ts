import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Palette = {
  bg: string;
  bgSecondary: string;
  bgSidebar: string;
  accent: string;
  accentDim: string;
  textPrimary: string;
  textMuted: string;
  textDim: string;
  border: string;
  statusOnline: string;
  statusOffline: string;
  statusWarning: string;
  statusInfo: string;
  codeBg: string;
  font: string;
};

// the lab-web stylesheet is the one source for these tokens — never re-declare a palette here.
const THEME_CSS = join(__dirname, '..', '..', '..', 'local-lab-web', 'src', 'styles', 'brokkr-theme.css');

export const DEFAULT_THEME = 'hydra-dark';

const TOKENS = {
  bg: '--color-bg-primary',
  bgSecondary: '--color-bg-secondary',
  bgSidebar: '--color-bg-sidebar',
  accent: '--color-accent',
  accentDim: '--color-accent-dim',
  textPrimary: '--color-text-primary',
  textMuted: '--color-text-muted',
  textDim: '--color-text-dim',
  border: '--color-border-dim',
  statusOnline: '--color-status-online',
  statusOffline: '--color-status-offline',
  statusWarning: '--color-status-warning',
  statusInfo: '--color-status-info',
  font: '--font-mono',
} as const;

// the docs seat code samples on a panel a shade below the page; the design system has no token for it
const CODE_BG = '#08061a';
const CODE_BG_BY_THEME: Record<string, string | undefined> = {
  yellow: '#0a0705',
  'hydra-light': '#e8e7ff',
  'solarized-light': '#e2dfd9',
};

type Declarations = Map<string, string>;
type Layers = { base: Declarations; themes: Map<string, Declarations> };

let cached: Layers | undefined;

function declarations(block: string): Declarations {
  const found: Declarations = new Map();
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    found.set(String(match[1]), String(match[2]).trim());
  }
  return found;
}

function readLayers(): Layers {
  if (cached) return cached;
  if (!existsSync(THEME_CSS)) {
    throw new Error(`lab theme stylesheet not found at '${THEME_CSS}'; the docs palettes are read from it.`);
  }
  const css = readFileSync(THEME_CSS, 'utf8');
  const base = declarations(/@theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? '');
  if (base.size === 0) throw new Error(`no @theme token block found in '${THEME_CSS}'.`);
  const themes = new Map<string, Declarations>();
  for (const match of css.matchAll(/\[data-theme=['"]([a-z0-9-]+)['"]\]\s*\{([^}]*)\}/gi)) {
    themes.set(String(match[1]), declarations(String(match[2])));
  }
  cached = { base, themes };
  return cached;
}

function tokenValue(token: string, theme: Declarations | undefined, base: Declarations): string {
  let value = theme?.get(token) ?? base.get(token);
  for (let hops = 0; value?.startsWith('var(') && hops < 4; hops++) {
    const referenced = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value)?.[1];
    value = referenced ? (theme?.get(referenced) ?? base.get(referenced)) : undefined;
  }
  if (!value || value.startsWith('var(')) {
    throw new Error(`theme token '${token}' is missing or unresolvable in '${THEME_CSS}'.`);
  }
  return value;
}

export function themeNames(): string[] {
  return [...readLayers().themes.keys()];
}

export function paletteFor(theme?: string): Palette {
  const { base, themes } = readLayers();
  const name = theme && themes.has(theme) ? theme : DEFAULT_THEME;
  const declared = themes.get(name);
  const value = (token: string) => tokenValue(token, declared, base);
  return {
    bg: value(TOKENS.bg),
    bgSecondary: value(TOKENS.bgSecondary),
    bgSidebar: value(TOKENS.bgSidebar),
    accent: value(TOKENS.accent),
    accentDim: value(TOKENS.accentDim),
    textPrimary: value(TOKENS.textPrimary),
    textMuted: value(TOKENS.textMuted),
    textDim: value(TOKENS.textDim),
    border: value(TOKENS.border),
    statusOnline: value(TOKENS.statusOnline),
    statusOffline: value(TOKENS.statusOffline),
    statusWarning: value(TOKENS.statusWarning),
    statusInfo: value(TOKENS.statusInfo),
    codeBg: CODE_BG_BY_THEME[name] ?? CODE_BG,
    font: value(TOKENS.font),
  };
}
