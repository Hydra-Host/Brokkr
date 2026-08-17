import { appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { FISH_SCRIPT } from './scripts/fish.js';

export type Shell = 'bash' | 'zsh' | 'fish';

const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
const MARKER_BEGIN = '# >>> brokkr completion >>>';
const MARKER_END = '# <<< brokkr completion <<<';
const FISH_FILE_MARKER = '# brokkr fish completion';

export function isShell(arg: string): arg is Shell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(arg);
}

export function detectShell(): Shell | null {
  const shellPath = process.env.SHELL;
  if (!shellPath) return null;
  const name = basename(shellPath);
  return isShell(name) ? name : null;
}

export function rcPath(shell: Shell): string {
  const home = homedir();
  switch (shell) {
    case 'zsh':
      return join(home, '.zshrc');
    case 'bash':
      return join(home, '.bashrc');
    case 'fish':
      return join(home, '.config', 'fish', 'completions', 'brokkr.fish');
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function evalBlock(shell: Exclude<Shell, 'fish'>): string {
  const lines = [MARKER_BEGIN, '# Added by `brokkr completion install`. Remove with `brokkr completion uninstall`.'];
  if (shell === 'zsh') {
    lines.push('(( $+_comps )) || { autoload -Uz compinit && compinit -u; }');
  }
  lines.push(`eval "$(brokkr completion script ${shell})"`);
  lines.push(MARKER_END);
  return lines.join('\n');
}

export type InstallResult = { action: 'installed'; path: string } | { action: 'already-installed'; path: string };

export type UninstallResult = { action: 'uninstalled'; path: string } | { action: 'not-found'; path: string };

export function installCompletion(shell: Shell): InstallResult {
  const path = rcPath(shell);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readIfExists(path);

  if (shell === 'fish') {
    if (existing?.includes(FISH_FILE_MARKER)) return { action: 'already-installed', path };
    writeFileSync(path, FISH_SCRIPT, 'utf-8');
    return { action: 'installed', path };
  }

  if (existing?.includes(MARKER_BEGIN)) return { action: 'already-installed', path };
  const prefix = !existing || existing.endsWith('\n') ? '' : '\n';
  appendFileSync(path, prefix + '\n' + evalBlock(shell) + '\n');
  return { action: 'installed', path };
}

export function uninstallCompletion(shell: Shell): UninstallResult {
  const path = rcPath(shell);
  const content = readIfExists(path);
  if (content === null) return { action: 'not-found', path };

  if (shell === 'fish') {
    if (!content.includes(FISH_FILE_MARKER)) return { action: 'not-found', path };
    unlinkSync(path);
    return { action: 'uninstalled', path };
  }

  if (!content.includes(MARKER_BEGIN)) return { action: 'not-found', path };
  const kept: string[] = [];
  let inBlock = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === MARKER_BEGIN) inBlock = true;
    else if (trimmed === MARKER_END) inBlock = false;
    else if (!inBlock) kept.push(line);
  }
  while (kept.length > 1 && kept[kept.length - 1] === '' && kept[kept.length - 2] === '') kept.pop();
  writeFileSync(path, kept.join('\n'));
  return { action: 'uninstalled', path };
}
