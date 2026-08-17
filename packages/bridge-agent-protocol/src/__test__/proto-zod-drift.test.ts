
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { deployOS, installLuksScripts } from '../operations/deploy.js';
import { operations } from '../operations/index.js';
import { DiskLayout, DiskReport, EncryptedVolume, ResolvedDiskLayout, wipeDisks } from '../operations/storage.js';

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'proto', 'brokkr', 'agent', 'v1', 'operations'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate proto/ from ${process.cwd()}`);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

function toPascalCase(s: string): string {
  return s
    .split(/[_-]|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((seg) => seg.length > 0)
    .map(capitalize)
    .join('');
}

function readAllOperationMessages(): Set<string> {
  const opsDir = join(repoRoot(), 'proto', 'brokkr', 'agent', 'v1', 'operations');
  const messages = new Set<string>();
  for (const entry of readdirSync(opsDir)) {
    if (!entry.endsWith('.proto')) continue;
    const content = readFileSync(join(opsDir, entry), 'utf-8');
    for (const match of content.matchAll(/^message\s+([A-Z][A-Za-z0-9]+)/gm)) {
      messages.add(match[1]!);
    }
  }
  return messages;
}

function protoMessageFields(protoText: string, messageName: string): string[] {
  const open = new RegExp(`^message\\s+${messageName}\\s*\\{`, 'm');
  const m = open.exec(protoText);
  if (!m) throw new Error(`proto message not found: ${messageName}`);
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = m.index; i < protoText.length; i++) {
    const ch = protoText[i];
    if (ch === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (start === -1 || end === -1) throw new Error(`unterminated proto message: ${messageName}`);
  const body = protoText.slice(start, end);
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('//')) continue;
    const fm = /^(?:optional\s+|repeated\s+)?[A-Za-z0-9_.<>, ]+?\s+([a-z][a-z0-9_]*)\s*=\s*\d+\s*;/.exec(trimmed);
    if (fm) fields.push(fm[1]!);
  }
  return fields;
}

function zodObjectKeys(schema: z.ZodTypeAny): string[] {
  let s: z.ZodTypeAny = schema;
  while (
    !(s instanceof z.ZodObject) &&
    'unwrap' in (s as object) &&
    typeof (s as { unwrap?: unknown }).unwrap === 'function'
  ) {
    s = (s as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
  }
  if (!(s instanceof z.ZodObject)) throw new Error('expected a ZodObject');
  return Object.keys((s as z.ZodObject<z.ZodRawShape>).shape);
}

function expectedProtoNames(zodKey: string): { input: string; output: string } {
  const dot = zodKey.indexOf('.');
  if (dot === -1) {
    throw new Error(`malformed Zod operation key (expected 'namespace.op'): ${zodKey}`);
  }
  const ns = zodKey.slice(0, dot);
  const op = zodKey.slice(dot + 1);
  const base = toPascalCase(ns) + toPascalCase(op);
  return { input: `${base}Input`, output: `${base}Output` };
}

describe('proto ↔ zod operation drift', () => {
  const protoMessages = readAllOperationMessages();

  const KNOWN_DRIFT = new Set<string>(['diagnostic.write_serial_tokens']);

  it('every Zod operation has a matching proto Input/Output pair', () => {
    const missing: string[] = [];
    for (const key of Object.keys(operations)) {
      if (KNOWN_DRIFT.has(key)) continue;
      const { input, output } = expectedProtoNames(key);
      if (!protoMessages.has(input)) missing.push(`${key} → ${input}`);
      if (!protoMessages.has(output)) missing.push(`${key} → ${output}`);
    }
    expect(missing, `proto messages missing for Zod ops:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('every proto Input/Output pair has a matching Zod operation', () => {
    const zodExpected = new Set<string>();
    for (const key of Object.keys(operations)) {
      const { input, output } = expectedProtoNames(key);
      zodExpected.add(input);
      zodExpected.add(output);
    }
    const orphans: string[] = [];
    for (const msg of protoMessages) {
      if (!msg.endsWith('Input')) continue;
      const pair = msg.replace(/Input$/, 'Output');
      if (!protoMessages.has(pair)) continue;
      if (!zodExpected.has(msg)) orphans.push(msg);
      if (!zodExpected.has(pair)) orphans.push(pair);
    }
    expect(orphans, `proto operation messages with no Zod counterpart:\n  ${orphans.join('\n  ')}`).toEqual([]);
  });
});

describe('proto ↔ zod field parity (disk-options reusable messages)', () => {
  const storageProto = readFileSync(
    join(repoRoot(), 'proto', 'brokkr', 'agent', 'v1', 'operations', 'storage.proto'),
    'utf-8',
  );

  const cases: Array<{ proto: string; zod: z.ZodTypeAny; label: string; mustInclude: string[] }> = [
    {
      proto: 'StorageDiskLayout',
      zod: DiskLayout,
      label: 'DiskLayout',
      mustInclude: ['fs_type', 'mountpoint', 'wipe', 'disks'],
    },
    {
      proto: 'StorageResolvedDiskLayout',
      zod: ResolvedDiskLayout,
      label: 'ResolvedDiskLayout',
      mustInclude: ['fs_type', 'mountpoint', 'wipe', 'disks', 'size_bytes'],
    },
    {
      proto: 'StorageDiskReport',
      zod: DiskReport,
      label: 'DiskReport',
      mustInclude: ['wipe_error', 'verification', 'result'],
    },
  ];

  for (const { proto, zod, label, mustInclude } of cases) {
    it(`${label}: proto field set equals the Zod field set`, () => {
      const protoFields = new Set(protoMessageFields(storageProto, proto));
      const zodFields = new Set(zodObjectKeys(zod));

      const missingFromProto = [...zodFields].filter((f) => !protoFields.has(f));
      const missingFromZod = [...protoFields].filter((f) => !zodFields.has(f));

      expect(
        missingFromProto,
        `${label}: Zod fields with no matching ${proto} proto field: ${missingFromProto.join(', ')}`,
      ).toEqual([]);
      expect(
        missingFromZod,
        `${label}: ${proto} proto fields with no matching Zod field: ${missingFromZod.join(', ')}`,
      ).toEqual([]);
    });

    it(`${label}: carries the data-loss-critical fields on both sides`, () => {
      const protoFields = new Set(protoMessageFields(storageProto, proto));
      const zodFields = new Set(zodObjectKeys(zod));
      for (const f of mustInclude) {
        expect(protoFields.has(f), `${proto} proto must declare field "${f}"`).toBe(true);
        expect(zodFields.has(f), `${label} Zod must declare field "${f}"`).toBe(true);
      }
    });
  }

  const deployProto = readFileSync(
    join(repoRoot(), 'proto', 'brokkr', 'agent', 'v1', 'operations', 'deploy.proto'),
    'utf-8',
  );

  const deployCases: Array<{ proto: string; zod: z.ZodTypeAny; label: string }> = [
    { proto: 'DeployInstallLuksScriptsInput', zod: installLuksScripts.input, label: 'installLuksScripts' },
    { proto: 'DeployDeployOsInput', zod: deployOS.input, label: 'deployOS' },
  ];

  for (const { proto, zod, label } of deployCases) {
    it(`${label}: carries rekey_volumes on both sides`, () => {
      const protoFields = new Set(protoMessageFields(deployProto, proto));
      const zodFields = new Set(zodObjectKeys(zod));
      expect(protoFields.has('rekey_volumes'), `${proto} proto must declare field "rekey_volumes"`).toBe(true);
      expect(zodFields.has('rekey_volumes'), `${label} Zod must declare field "rekey_volumes"`).toBe(true);
    });
  }

  it('EncryptedVolume: proto field set equals the Zod field set', () => {
    const protoFields = new Set(protoMessageFields(deployProto, 'DeployEncryptedVolumeConfig'));
    const zodFields = new Set(zodObjectKeys(EncryptedVolume));
    const missingFromProto = [...zodFields].filter((f) => !protoFields.has(f));
    const missingFromZod = [...protoFields].filter((f) => !zodFields.has(f));
    expect(
      missingFromProto,
      `EncryptedVolume Zod fields with no matching DeployEncryptedVolumeConfig proto field: ${missingFromProto.join(', ')}`,
    ).toEqual([]);
    expect(
      missingFromZod,
      `DeployEncryptedVolumeConfig proto fields with no matching EncryptedVolume Zod field: ${missingFromZod.join(', ')}`,
    ).toEqual([]);
    expect(protoFields.has('luks_uuid'), 'DeployEncryptedVolumeConfig proto must declare field "luks_uuid"').toBe(true);
    expect(zodFields.has('luks_uuid'), 'EncryptedVolume Zod must declare field "luks_uuid"').toBe(true);
  });

  it('wipeDisks: carries full_wipe on both sides', () => {
    const protoFields = new Set(protoMessageFields(storageProto, 'StorageWipeDisksInput'));
    const zodFields = new Set(zodObjectKeys(wipeDisks.input));
    expect(protoFields.has('full_wipe'), 'StorageWipeDisksInput proto must declare field "full_wipe"').toBe(true);
    expect(zodFields.has('full_wipe'), 'wipeDisks Zod must declare field "full_wipe"').toBe(true);
  });

  it('StorageWipeError sub-message matches the Zod wipe_error sub-object', () => {
    const protoFields = new Set(protoMessageFields(storageProto, 'StorageWipeError'));
    const wipeError = (DiskReport as z.ZodObject<z.ZodRawShape>).shape['wipe_error'];
    const zodFields = new Set(zodObjectKeys(wipeError as z.ZodTypeAny));
    expect([...zodFields].sort()).toEqual([...protoFields].sort());
  });
});
