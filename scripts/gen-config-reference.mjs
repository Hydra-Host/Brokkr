#!/usr/bin/env node
// Renders devenv/README.md's two generated tables: the knob surface from `devenv eval
// knobCatalog`, the fleet node fields from schema.py. Run via `task docs:config`.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// the built contract, not a copy of its rules: this is the one place the live catalog and the
// classifier meet, so a knob added to a .nix module is gated against the same tables the lab uses.
import { applyClassFor, unclassifiedWritableKnobs } from '../packages/local-lab-contract/dist/index.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const README = join(ROOT, 'devenv', 'README.md');
const SIM_SCRIPTS = join(ROOT, 'apps', 'local-sim', 'scripts');
const PRETTIER = join(ROOT, 'node_modules', '.bin', 'prettier');

// devenv.nix is copied, not symlinked: a symlink resolves its own `pathExists ./stack.local.nix`
// probes against the real root and pulls the layers back in. devenv may rewrite the other two.
const SANDBOX_COPIES = ['devenv.nix', 'devenv.yaml', 'devenv.lock'];
const SANDBOX_OMITS = new Set([
  ...SANDBOX_COPIES,
  'devenv.local.nix',
  'stack.local.nix',
  'env.local.nix',
  'stack.slot.nix',
  '.devenv',
  '.direnv',
]);

// Twelve knob defaults derive from config.stack.slot and the four override layers are ordinary
// modules, so an in-place eval would bake this developer's slot and overlay into a committed file.
function withSandbox(run) {
  const dir = mkdtempSync(join(tmpdir(), 'brokkr-config-reference-'));
  try {
    for (const entry of readdirSync(ROOT)) {
      if (SANDBOX_OMITS.has(entry) || /^\.env($|\.)/.test(entry)) continue;
      symlinkSync(join(ROOT, entry), join(dir, entry));
    }
    for (const file of SANDBOX_COPIES) copyFileSync(join(ROOT, file), join(dir, file));
    return run(dir);
  } finally {
    if (!dir.startsWith(tmpdir())) throw new Error(`refusing to remove ${dir}: not under the temp root`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// Both attributes come out of one sandbox so they describe the same eval, and so the second read
// costs nothing beyond the eval cache the first one warmed.
function catalogAndRefusals() {
  return withSandbox((cwd) => {
    const read = (attr) => {
      const raw = execFileSync('devenv', ['eval', attr], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: {
          ...process.env,
          SECRETSPEC_REASON: process.env.SECRETSPEC_REASON || 'generate the committed config reference',
          BROKKR_ENV_PINS: 'off',
        },
      });
      return JSON.parse(raw)[attr];
    };
    return { catalog: read('knobCatalog'), refusals: read('envPinRefusals') };
  });
}

function fleetNodeSchema() {
  const program = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(SIM_SCRIPTS)})`,
    'from local.schema import NodeRaw',
    'json.dump(NodeRaw.model_json_schema(mode="validation"), sys.stdout)',
  ].join('\n');
  return JSON.parse(
    execFileSync('python3', ['-c', program], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

const cell = (value) =>
  String(value)
    .replace(/\r?\n\s*/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
const code = (value) => `\`${String(value).replace(/`/g, '')}\``;
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

function table(headers, rows) {
  const separator = headers.map(() => '---');
  return [headers, separator, ...rows].map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function defaultCell(value) {
  if (value === null || value === undefined) return '—';
  if (value === '') return 'empty';
  return code(value);
}

// The catalog already flags a secret; printing its default would publish the value into a committed
// file, which is the one place it must never land. The fleet-node table has no such flag to consult.
function knobDefaultCell(entry) {
  return entry.secret ? 'not printed (secret)' : defaultCell(entry.default);
}

function kindCell(entry) {
  return entry.choices.length === 0 ? code(entry.kind) : entry.choices.map(code).join(' / ');
}

// Reads the refusal env-pins.nix publishes rather than re-deciding it: mirroring the flags here
// missed the branch for a knob whose value embeds a secret, and advertised a pin the eval refuses.
function pinCell(entry, refusals) {
  const refusal = refusals.get(entry.path);
  if (refusal) return `refuses a pin — ${refusal}`;
  return code(entry.pinEnv ?? `BROKKR_CFG_${entry.path.replace(/\./g, '__')}`);
}

function pinRefusalList(refusals) {
  return [...refusals.entries()].map(([path, reason]) => `- ${code(path)} — ${reason}.`).join('\n');
}

const applyCostCell = (entry) => {
  const applyClass = applyClassFor(entry.path);
  return applyClass ? code(applyClass) : 'read-only';
};

function optionReference(catalog, refusals) {
  const unclassified = unclassifiedWritableKnobs(catalog);
  if (unclassified.length > 0)
    throw new Error(
      `no apply-class rule owns these writable knobs, so a save would offer a cost it cannot state: ${unclassified.join(', ')}. Add a rule to packages/local-lab-contract/src/apply-class.ts.`,
    );
  const rows = [...catalog]
    .sort(byPath)
    .map((entry) => [
      code(entry.path),
      kindCell(entry),
      knobDefaultCell(entry),
      applyCostCell(entry),
      pinCell(entry, refusals),
      cell(entry.danger ? `**Danger.** ${entry.description}` : entry.description),
    ]);
  return table(['Knob', 'Kind', 'Default', 'Apply cost', 'Pin variable', 'What it controls'], rows);
}

// Pydantic carries the docstrings through as RST; the literal is the only markup they use.
function prose(text) {
  if (!text) return [];
  return text
    .replace(/``([^`]+)``/g, '`$1`')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);
}

const refName = (schema) => schema.$ref.split('/').pop();

function typeCell(schema) {
  if (schema.anyOf) {
    return schema.anyOf
      .filter((branch) => branch.type !== 'null')
      .map(typeCell)
      .join(' or ');
  }
  if (schema.enum) return schema.enum.map(code).join(' / ');
  if (schema.$ref) return code(refName(schema));
  if (schema.type === 'array') return code(`${schema.items.$ref ? refName(schema.items) : schema.items.type}[]`);
  return code(schema.type ?? 'any');
}

function fieldTable(model) {
  const required = new Set(model.required ?? []);
  const rows = Object.entries(model.properties).map(([name, schema]) => [
    code(name),
    typeCell(schema),
    required.has(name) ? '**required**' : defaultCell(schema.default ?? null),
  ]);
  return table(['Field', 'Type', 'Default'], rows);
}

function fleetNodeReference(schema) {
  const sections = [...prose(schema.description), fieldTable(schema)];
  const refs = JSON.stringify(schema.properties).match(/#\/\$defs\/[A-Za-z0-9_]+/g) ?? [];
  for (const name of [...new Set(refs.map((ref) => ref.split('/').pop()))].sort()) {
    const model = schema.$defs[name];
    sections.push(`#### \`${name}\``, ...prose(model.description), fieldTable(model));
  }
  return sections.join('\n\n');
}

function splice(markdown, marker, body) {
  const begin = `<!-- BEGIN GENERATED: ${marker} -->`;
  const end = `<!-- END GENERATED: ${marker} -->`;
  const pattern = new RegExp(`${begin}[\\s\\S]*?${end}`);
  if (!pattern.test(markdown)) throw new Error(`devenv/README.md is missing the marker pair ${begin} … ${end}`);
  return markdown.replace(pattern, `${begin}\n\n${body}\n\n${end}`);
}

const { catalog, refusals } = catalogAndRefusals();
const refusalMap = new Map(refusals.map((r) => [r.path, r.reason]));

let markdown = readFileSync(README, 'utf8');
markdown = splice(markdown, 'option-reference', optionReference(catalog, refusalMap));
markdown = splice(markdown, 'pin-refusals', pinRefusalList(refusalMap));
markdown = splice(markdown, 'fleet-node-fields', fleetNodeReference(fleetNodeSchema()));
writeFileSync(README, markdown);

// Markdown here is prettier-owned (unlike the treefmt-excluded THIRD-PARTY-LICENSES.md) and
// prettier pads table columns, so let it settle the layout instead of reimplementing the padding.
execFileSync(PRETTIER, ['--write', README], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
console.log(`Wrote the option and fleet-node references into ${README}`);
