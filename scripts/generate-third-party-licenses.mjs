#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = 'THIRD-PARTY-LICENSES.md';
const LICENSE_FILE = /^(LICEN[SC]E|COPYING|NOTICE)/i;
const NO_TEXT = '_No license text found in the package; see the SPDX identifier above._';

export const ALLOWLIST = new Set([
  'Apache-2.0',
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'WTFPL',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'MPL-2.0',
  'CC-BY-4.0',
  'OFL-1.1',
]);

export const SPDX_ALIASES = { 'Apache 2.0': 'Apache-2.0' };

export function licenseAllowed(expr) {
  const tokens = (SPDX_ALIASES[expr] || expr).match(/\(|\)|[^\s()]+/g) || [];
  let i = 0;
  let bad = false;
  const parseExpr = () => {
    let v = parseAnd();
    while (tokens[i] === 'OR') {
      i++;
      v = parseAnd() || v;
    }
    return v;
  };
  const parseAnd = () => {
    let v = parseAtom();
    while (tokens[i] === 'AND') {
      i++;
      v = parseAtom() && v;
    }
    return v;
  };
  const parseAtom = () => {
    if (tokens[i] === '(') {
      i++;
      const v = parseExpr();
      if (tokens[i] === ')') i++;
      else bad = true;
      return v;
    }
    const t = tokens[i++];
    if (t === undefined) return false;
    if (tokens[i] === 'WITH') i += 2;
    return ALLOWLIST.has(t.replace(/\+$/, ''));
  };
  const result = parseExpr();
  return !bad && i === tokens.length && result;
}

const RESOLVED = {
  graphmatch: { license: 'MIT', note: "MIT per the package's bundled `license` file (Copyright Fabio Spampinato)." },
  '@mapbox/jsonlint-lines-primitives': {
    license: 'MIT',
    note: 'Ships no explicit license; fork of zaach/jsonlint (same author, Zach Carter) which is MIT. Confirm at publish.',
  },
  'url-template': {
    license: 'BSD-3-Clause',
    note: 'Declares the legacy non-SPDX id "BSD"; the bundled license file is verbatim BSD-3-Clause (retain/reproduce notice plus the no-endorsement clause).',
  },
};
const ELECT = {
  dompurify: {
    license: 'Apache-2.0',
    from: '(MPL-2.0 OR Apache-2.0)',
    note: 'Dual-licensed; we elect Apache-2.0 (matches the repo license; discharges the MPL option).',
  },
};
const LICENSE_NOTES = {
  'MPL-2.0':
    'Weak copyleft. Used unmodified as a dependency — obligation is attribution plus making the unmodified source available on request; no effect on first-party code.',
  'CC-BY-4.0': 'Build-time data only (browser-support tables); attribution required, no code impact.',
  'Python-2.0': 'Permissive (PSF license); attribution only.',
};

const PLATFORM_NATIVE_OS_ARCH =
  /(?:^|[-/@])(?:darwin|linux|win32|freebsd|openbsd|netbsd|android|openharmony|sunos|aix)-(?:x64|arm64|arm|ia32|s390x|ppc64|ppc64le|riscv64|loong64|x86|mips64el|mipsel|universal)\b/;
export function isPlatformNativePackage(name) {
  return name === 'fsevents' || PLATFORM_NATIVE_OS_ARCH.test(name);
}

// Linked workspace packages are omitted from `pnpm licenses list`; `file:` copies of @hydrahost/@repo are not.
export function isFirstPartyPackage(name) {
  return name.startsWith('@hydrahost/') || name.startsWith('@repo/');
}

let installedPackageIndex;
function packageKey(name, version) {
  return `${name}\0${version}`;
}

// Every `<store>/<pkg>@<ver>/node_modules/<name>` directory, scoped names included. This is where
// an isolated install puts packages; it writes no hoistedLocations at all.
export function virtualStorePackagePaths(storeDir) {
  if (!existsSync(storeDir)) return [];
  const paths = [];
  for (const entry of readdirSync(storeDir)) {
    const nested = join(storeDir, entry, 'node_modules');
    if (!existsSync(nested)) continue;
    for (const name of readdirSync(nested)) {
      if (name.startsWith('@')) {
        const scope = join(nested, name);
        if (!existsSync(scope)) continue;
        for (const sub of readdirSync(scope)) paths.push(join(scope, sub));
      } else {
        paths.push(join(nested, name));
      }
    }
  }
  return paths;
}

// pnpm >=10 writes .modules.yaml as JSON; pnpm 8 wrote YAML scrapable only by indentation. Under
// nodeLinker=isolated (what the licence CI jobs use) the JSON carries no hoistedLocations.
export function installedPackagePaths(modulesState, modulesDir = 'node_modules') {
  try {
    const state = JSON.parse(modulesState);
    const hoisted = Object.values(state.hoistedLocations ?? {}).flat();
    if (hoisted.length) return hoisted;
    const vsd = state.virtualStoreDir ?? '.pnpm';
    return virtualStorePackagePaths(vsd.startsWith('/') ? vsd : join(modulesDir, vsd));
  } catch {
    return [...modulesState.matchAll(/^    - ((?:.+\/)?node_modules\/.+)$/gm)].map((m) => m[1]);
  }
}

function getInstalledPackageIndex() {
  if (installedPackageIndex) return installedPackageIndex;
  const index = new Map();
  const modulesState = readFileSync('node_modules/.modules.yaml', 'utf8');
  for (const path of installedPackagePaths(modulesState)) {
    try {
      const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
      const key = packageKey(manifest.name, manifest.version);
      const paths = index.get(key) || [];
      paths.push(path);
      index.set(key, paths);
    } catch (error) {
      console.warn('reading installed package manifest failed:', error);
    }
  }
  installedPackageIndex = index;
  return index;
}

export function indexedPackagePaths(entry, index) {
  const versions = Array.isArray(entry.versions) ? entry.versions : [entry.version];
  return [...new Set(versions.flatMap((version) => index.get(packageKey(entry.name, version)) || []))];
}

function packagePaths(entry) {
  const reported = entry.paths || (entry.path ? [entry.path] : []);
  const existing = reported.filter((path) => path && existsSync(path));
  if (existing.length) return existing;

  const indexed = indexedPackagePaths(entry, getInstalledPackageIndex());
  if (indexed.length) return indexed;
  const version = Array.isArray(entry.versions) ? entry.versions.join(', ') : entry.version || 'unknown';
  throw new Error(`Failed to resolve installed package root for ${entry.name}@${version}`);
}

export function normalizeLicenseText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function licenseText(paths) {
  for (const p of paths || []) {
    if (!p || !existsSync(p)) continue;
    try {
      const f = readdirSync(p).find((n) => LICENSE_FILE.test(n));
      if (f) {
        const t = normalizeLicenseText(readFileSync(join(p, f), 'utf8'));
        if (t) return t;
      }
    } catch (error) {
      console.warn('reading license file failed:', error);
    }
  }
  return null;
}

// pnpm-store workaround: a half-imported package kills `pnpm licenses list` with ERR_PNPM_MISSING_PACKAGE_INDEX_FILE; only `pnpm store add <pkg>` repairs it (install/--force don't).
const MISSING_INDEX_RE = /Failed to find package index file for \/((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)\/([a-z0-9.+-]+)/i;

function listProdLicenses(maxRepairs = 10) {
  for (let repairs = 0; ; repairs++) {
    try {
      return execSync('pnpm licenses list --prod --json', { maxBuffer: 1024 * 1024 * 512 }).toString();
    } catch (error) {
      const output = [error.stdout, error.stderr].map((buf) => (buf ? buf.toString() : '')).join('\n');
      const broken = MISSING_INDEX_RE.exec(output);
      if (!broken || repairs >= maxRepairs) throw error;
      console.error(`store index missing for ${broken[1]}@${broken[2]}; repairing via pnpm store add`);
      execFileSync('pnpm', ['store', 'add', `${broken[1]}@${broken[2]}`], { stdio: 'inherit' });
    }
  }
}

function main() {
  const raw = listProdLicenses();
  const data = JSON.parse(raw);
  const CHECK = process.argv.includes('--check');

  const pkgs = [];
  let total = 0;
  let skippedNatives = 0;
  const byLicense = {};
  const resolutions = [];
  for (const [reported, entries] of Object.entries(data)) {
    for (const e of entries) {
      if (isFirstPartyPackage(e.name)) continue;
      if (isPlatformNativePackage(e.name)) {
        skippedNatives++;
        continue;
      }
      total++;
      const paths = packagePaths(e);
      let license = reported;
      let resolution = '';
      if (RESOLVED[e.name]) {
        license = RESOLVED[e.name].license;
        resolution = `Resolved from "${reported}" → ${license}: ${RESOLVED[e.name].note}`;
      } else if (ELECT[e.name]) {
        license = ELECT[e.name].license;
        resolution = `Elected ${license} from ${ELECT[e.name].from}: ${ELECT[e.name].note}`;
      }
      if (resolution) resolutions.push({ name: e.name, line: `- \`${e.name}\` — ${resolution}` });
      byLicense[license] = (byLicense[license] || 0) + 1;
      pkgs.push({
        name: e.name,
        version: Array.isArray(e.versions) ? e.versions.join(', ') : e.version || '',
        license,
        resolution,
        homepage: e.homepage || '',
        author: typeof e.author === 'string' ? e.author : e.author?.name || '',
        text: licenseText(paths),
      });
    }
  }
  pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  // Deterministic order so the drift gate doesn't false-fail on pnpm iteration reordering.
  resolutions.sort((a, b) => a.name.localeCompare(b.name));

  const notable = Object.keys(byLicense)
    .filter((l) => LICENSE_NOTES[l])
    .sort();

  const out = [];
  out.push('# Third-Party Licenses');
  out.push('');
  out.push('> **Auto-generated — do not edit by hand.** Regenerate with `pnpm licenses:third-party`');
  out.push('> (`scripts/generate-third-party-licenses.mjs`, sourced from `pnpm licenses list --prod --json`).');
  out.push('');
  out.push(`This project bundles the following ${total} production dependencies. Their licenses and, where`);
  out.push('available, their license texts are reproduced below to satisfy attribution requirements.');
  out.push('');
  out.push('> Platform-specific prebuilt native binaries (e.g. `@esbuild/<os>`, `@rollup/rollup-<os>-<libc>`,');
  out.push('> `lightningcss-<os>`, `@tailwindcss/oxide-<os>`, `fsevents`) are omitted: each is a binary build of a');
  out.push('> platform-independent parent package listed below under the same license, and listing them would tie');
  out.push('> this file to the build host. They are covered by their parent package’s attribution.');
  out.push('');
  out.push('## Summary by license');
  out.push('');
  out.push('| License | Packages |');
  out.push('| --- | ---: |');
  for (const l of Object.keys(byLicense).sort()) out.push(`| ${l} | ${byLicense[l]} |`);
  out.push('');
  if (resolutions.length) {
    out.push('## License resolutions');
    out.push('');
    out.push('Entries pnpm could not classify, or that are dual-licensed, resolved against the source:');
    out.push('');
    resolutions.forEach((r) => out.push(r.line));
    out.push('');
  }
  if (notable.length) {
    out.push('## License obligations');
    out.push('');
    for (const l of notable) out.push(`- **${l}** (${byLicense[l]} pkg) — ${LICENSE_NOTES[l]}`);
    out.push('');
  }
  out.push('## Packages');
  out.push('');
  for (const p of pkgs) {
    out.push(`### ${p.name}@${p.version}`);
    out.push('');
    out.push(`- License: \`${p.license}\``);
    if (p.resolution) out.push(`- ${p.resolution}`);
    if (p.homepage) out.push(`- Homepage: ${p.homepage}`);
    if (p.author) out.push(`- Author: ${p.author}`);
    out.push('');
    if (p.text) {
      out.push('```');
      out.push(p.text);
      out.push('```');
      out.push('');
    } else {
      out.push(NO_TEXT);
      out.push('');
    }
  }
  const rendered = out.join('\n') + '\n';
  const unknown = byLicense['Unknown'] || 0;

  const disallowed = Object.keys(byLicense)
    .filter((l) => !licenseAllowed(l))
    .sort();

  if (CHECK) {
    const errors = [];
    if (disallowed.length) {
      errors.push(
        `Disallowed prod-dependency license(s) not in allowlist: ${disallowed
          .map((l) => `${l} (${byLicense[l]} pkg)`)
          .join(', ')}.`,
      );
    }
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== rendered) {
      errors.push(`${OUT} is out of date with pnpm-lock.yaml. Run \`pnpm licenses:third-party\` and commit.`);
    }
    if (errors.length) {
      for (const e of errors) console.error(`error: ${e}`);
      process.exit(1);
    }
    console.error(`${OUT} OK: ${total} deps, all licenses allowlisted, no drift.`);
    process.exit(0);
  }

  writeFileSync(OUT, rendered);
  console.error(
    `Wrote ${OUT}: ${total} deps across ${Object.keys(byLicense).length} licenses; ` +
      `${resolutions.length} resolved; ${skippedNatives} platform-native leaves omitted; Unknown remaining: ${unknown}`,
  );
  if (unknown > 0 || disallowed.length) {
    console.error(`error: unresolved/disallowed license(s): ${disallowed.join(', ') || 'Unknown'}.`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
