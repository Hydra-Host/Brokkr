import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '..', '..');

function deviceColumnsInSchema(): Set<string> {
  const schema = readFileSync(join(REPO_ROOT, 'packages/database/prisma/models/device.prisma'), 'utf8');
  const body = schema.slice(schema.indexOf('model Device {'));
  const end = body.indexOf('\n}');
  const fields = new Set<string>();
  for (const line of body.slice(0, end).split('\n').slice(1)) {
    const m = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s/.exec(line);
    if (m) fields.add(m[1]);
  }
  return fields;
}

function repositorySource(): string {
  return readFileSync(join(API_ROOT, 'src/ipam/prefix/prefix.repository.ts'), 'utf8');
}

function deviceColumnsInRawSql(): string[] {
  return [...repositorySource().matchAll(/\bd(?:ev)?\."([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
}

function bootIdentitySubqueries(): { pxe: string; bmc: string } {
  const source = repositorySource();
  const start = source.indexOf('async resolveBootIdentity(');
  const method = source.slice(start, source.indexOf('\n  }\n', start));
  const pxeEnd = method.indexOf('AS "pxeDeviceId"');
  const bmcEnd = method.indexOf('AS "bmcDeviceId"');
  return { pxe: method.slice(0, pxeEnd), bmc: method.slice(pxeEnd, bmcEnd) };
}

describe('prefix repository raw sql tracks the Device schema', () => {
  it('reads the schema at all', () => {
    const fields = deviceColumnsInSchema();

    expect(fields.size).toBeGreaterThan(5);
    expect(fields.has('supplierId')).toBe(true);
  });

  it('finds the device-aliased columns it is meant to check', () => {
    expect(deviceColumnsInRawSql().length).toBeGreaterThan(0);
  });

  it('names no Device column the schema does not have', () => {
    const fields = deviceColumnsInSchema();

    expect(deviceColumnsInRawSql().filter((c) => !fields.has(c))).toEqual([]);
  });
});

describe('prefix repository boot identity fences both subqueries on the supplier', () => {
  const SUPPLIER_FENCE = 'd."supplierId" = ${this.contextService.organizationId}';

  it('locates the pxe and bmc subqueries', () => {
    const { pxe, bmc } = bootIdentitySubqueries();

    expect(pxe).toContain('lower(i."macAddress") = ${mac}');
    expect(bmc).toContain('ip.address = ${bmcAddress}::inet');
  });

  it('fences the pxe subquery on the supplier', () => {
    expect(bootIdentitySubqueries().pxe).toContain(SUPPLIER_FENCE);
  });

  it('fences the bmc subquery on the supplier', () => {
    expect(bootIdentitySubqueries().bmc).toContain(SUPPLIER_FENCE);
  });
});
