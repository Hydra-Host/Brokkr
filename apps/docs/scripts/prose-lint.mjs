#!/usr/bin/env node
// Prose linter enforcing the mechanical rules in apps/docs/STYLE.md.
// Usage: node prose-lint.mjs [files or dirs...] (default apps/docs/content); exits 1 on errors.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = {
  emDashMax: 1, // STYLE.md: at most one em-dash per page, prefer zero
  contrastReversals: 1, // "x — not y" constructions per file
  tripletPerSentences: 10, // max one "a, b, and c" per N sentences
};

export const BANNED = [
  'seamless',
  'seamlessly',
  'robust',
  'powerful',
  'simply',
  'just works',
  'under the hood',
  'think of it as',
  "isn't just",
  'not just',
  "that's it",
  'real steel',
];

export function collect(path) {
  const st = statSync(path);
  if (st.isFile()) return path.endsWith('.mdx') || path.endsWith('.md') ? [path] : [];
  return readdirSync(path).flatMap((e) => collect(join(path, e)));
}

export function prose(raw) {
  let t = raw.replace(/^---[\s\S]*?---/, '');
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t
    .split('\n')
    .filter((l) => {
      const s = l.trim();
      return !s.startsWith('|') && !s.startsWith('import ') && !s.startsWith('export ');
    })
    .join('\n');
  t = t.replace(/`[^`]*`/g, 'CODE');
  return t;
}

export function analyze(raw) {
  const body = prose(raw);
  const words = body.split(/\s+/).filter(Boolean).length;
  const sentences = body
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?]) /)
    .filter((s) => s.split(' ').length > 2).length;

  const errors = [];
  const warns = [];

  const emDashes = (body.match(/—/g) ?? []).length;
  if (emDashes > LIMITS.emDashMax) {
    errors.push(`${emDashes} em-dashes (max ${LIMITS.emDashMax} per page)`);
  }

  const reversals = (body.match(/—\s*not\b/g) ?? []).length;
  if (reversals > LIMITS.contrastReversals) {
    errors.push(`${reversals} "— not" reversals (budget ${LIMITS.contrastReversals})`);
  }

  const litanies = (body.match(/\bno \w[\w' -]{0,25}, no \w/gi) ?? []).length;
  if (litanies > 0) errors.push(`${litanies} negative litany ("no x, no y")`);

  const triplets = (body.match(/\w[^.,:;()]{2,30}, [^.,:;()]{2,30},? (?:and|or) [^.,;]{2,40}/g) ?? []).length;
  const tripletBudget = Math.max(1, Math.floor(sentences / LIMITS.tripletPerSentences));
  if (triplets > tripletBudget) {
    warns.push(`${triplets} list-of-three constructions (budget ${tripletBudget})`);
  }

  const lower = body.toLowerCase();
  for (const phrase of BANNED) {
    const n = lower.split(phrase).length - 1;
    if (n > 0) warns.push(`banned phrase "${phrase}" x${n}`);
  }

  // Number + noun phrase only ("Five product surfaces"); a comma clause ("One hub, a bridge per zone") is descriptive, not counting.
  const countHeading = body.match(/^#+\s+(?:Three|Four|Five|Six|Seven|Eight|Nine|Ten)\s+[\w ]+$/gim);
  if (countHeading) warns.push(`counting heading: ${countHeading.map((h) => h.trim()).join('; ')}`);

  return { words, emDashes, errors, warns };
}

export function lint(file) {
  return { file, ...analyze(readFileSync(file, 'utf8')) };
}

function main() {
  const args = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const targets = args.length ? args : [join(here, '..', 'content')];
  const files = targets.flatMap((t) => collect(resolve(t)));
  let failed = 0;
  let clean = 0;

  for (const f of files) {
    const r = lint(f);
    if (r.errors.length === 0 && r.warns.length === 0) {
      clean += 1;
      continue;
    }
    if (r.errors.length > 0) failed += 1;
    const status = r.errors.length ? 'FAIL' : 'warn';
    console.log(`${status}  ${f}`);
    for (const e of r.errors) console.log(`      error: ${e}`);
    for (const w of r.warns) console.log(`      warn:  ${w}`);
  }

  console.log(`\n${files.length} files checked: ${clean} clean, ${failed} failing`);
  process.exit(failed > 0 ? 1 : 0);
}

// Run the CLI only when executed directly, so tests can import the pure helpers.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
