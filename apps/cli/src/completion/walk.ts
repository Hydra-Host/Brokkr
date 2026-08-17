import type { Command, Option } from 'commander';
import { getValueHints } from './value-hints.js';

function takesValue(opt: Option): boolean {
  return opt.required || opt.optional;
}

function optionFlagForms(opt: Option): string[] {
  return [opt.long, opt.short].filter((f): f is string => Boolean(f));
}

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

function commandPath(cmd: Command, root: Command): string {
  const parts: string[] = [];
  for (let current: Command | null = cmd; current && current !== root; current = current.parent) {
    parts.unshift(current.name());
  }
  return parts.join(' ');
}

export function isHidden(cmd: Command): boolean {
  if (cmd.name().startsWith('__')) return true;
  return (cmd as unknown as { _hidden?: boolean })._hidden === true;
}

export function visibleSubcommands(cmd: Command): Command[] {
  return cmd.commands.filter((c) => !isHidden(c));
}

export function candidatesFor(cmd: Command): string[] {
  const names = visibleSubcommands(cmd).map((c) => c.name());
  const flags = cmd.options.flatMap(optionFlagForms);
  return Array.from(new Set([...names, ...flags, '--help']));
}

export function walkTree(root: Command, words: string[]): string[] {
  const partial = words[words.length - 1] ?? '';
  const completed = words.slice(0, -1);

  let current = root;
  let i = 0;
  while (i < completed.length) {
    const sub = findSubcommand(current, completed[i]!);
    if (!sub) break;
    current = sub;
    i++;
  }
  const extras = completed.slice(i);
  const lastExtra = extras[extras.length - 1];

  if (lastExtra?.startsWith('--')) {
    const opt = current.options.find((o) => o.long === lastExtra);
    if (opt && takesValue(opt)) {
      const path = commandPath(current, root);
      const hints = getValueHints(path, lastExtra) ?? opt.argChoices ?? [];
      return hints.filter((v) => v.startsWith(partial)).sort();
    }
  }

  return candidatesFor(current)
    .filter((c) => c.startsWith(partial))
    .sort();
}
