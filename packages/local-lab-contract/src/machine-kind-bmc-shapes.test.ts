import { describe, expect, it } from 'vitest';
import { BmcProbeSchema, BootTrailSchema, MachineSchema, NodeKindSchema, VerifyFindingSchema } from './schemas/fleet';

const row = {
  name: 'cpu-1',
  kind: 'vm',
  power: 'on',
  configured: true,
  deviceId: null,
  bmc: null,
};

const finding = {
  node: 'bm-1',
  kind: 'bmc-unreachable',
  healable: false,
  detail: 'no answer from 10.10.0.5',
};

const emptyTrail = { pxe: null, chainReached: false, chainAtMs: null, readError: null };

describe('node kind and bmc probe on the machine row', () => {
  it('names the two node kinds in order', () => {
    expect(NodeKindSchema.options).toEqual(['vm', 'baremetal']);
  });

  it('requires both kind and bmc on every row', () => {
    expect(MachineSchema.parse(row)).toEqual(row);
    const { kind: _kind, ...noKind } = row;
    const { bmc: _bmc, ...noBmc } = row;
    expect(() => MachineSchema.parse(noKind)).toThrow();
    expect(() => MachineSchema.parse(noBmc)).toThrow();
  });

  it('carries a structured probe on a bare-metal row', () => {
    const probe = { reachable: 'auth-failed', powerState: null };
    expect(MachineSchema.parse({ ...row, kind: 'baremetal', bmc: probe }).bmc).toEqual(probe);
    expect(() => BmcProbeSchema.parse({ reachable: 'flaky', powerState: null })).toThrow();
  });
});

describe('verify finding code and ref', () => {
  it('accepts a finding that carries neither', () => {
    expect(VerifyFindingSchema.parse(finding)).toMatchObject(finding);
  });

  it('accepts a finding that carries both', () => {
    expect(VerifyFindingSchema.parse({ ...finding, code: 'PXE-102', ref: 'p-1' })).toMatchObject({
      code: 'PXE-102',
      ref: 'p-1',
    });
  });
});

describe('boot trail', () => {
  it('parses the not-recorded state', () => {
    expect(BootTrailSchema.parse(emptyTrail)).toEqual(emptyTrail);
  });

  it('rejects an unknown pxe outcome', () => {
    expect(() => BootTrailSchema.parse({ ...emptyTrail, pxe: { outcome: 'bogus', atMs: 1700 } })).toThrow();
  });

  it('parses an unread trail with a null chain verdict', () => {
    const unreadTrail = { pxe: null, chainReached: null, chainAtMs: null, readError: 'ECONNREFUSED 10.10.0.2:6379' };
    expect(BootTrailSchema.parse(unreadTrail)).toEqual(unreadTrail);
  });

  it('parses a reached chain with the time of the hit', () => {
    const reached = { ...emptyTrail, chainReached: true, chainAtMs: 1700 };
    expect(BootTrailSchema.parse(reached)).toEqual(reached);
  });

  it('describes every field of the new shapes', () => {
    for (const schema of [BmcProbeSchema, BootTrailSchema]) {
      for (const [name, field] of Object.entries(schema.shape)) {
        expect(field.description, `${name} is missing a describe()`).toBeTruthy();
      }
    }
  });
});
