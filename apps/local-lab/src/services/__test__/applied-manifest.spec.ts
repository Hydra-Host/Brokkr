import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planesEqual, readAppliedPlanes, VM_ONLY } from '../applied-manifest';

let dir: string;

const writeManifest = (raw: string): void => {
  mkdirSync(join(dir, 'state', 'run'), { recursive: true });
  writeFileSync(join(dir, 'state', 'run', 'fleet-applied.json'), raw);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lab-applied-manifest-'));
  process.env.LOCAL_STATE = dir;
});

afterEach(() => {
  delete process.env.LOCAL_STATE;
  rmSync(dir, { recursive: true, force: true });
});

describe('readAppliedPlanes', () => {
  it('reads both planes from a manifest carrying both rosters', () => {
    writeManifest(JSON.stringify({ nodes: [{ name: 'gpu-1' }], bmNodes: [{ name: 'metal-1' }] }));
    expect(readAppliedPlanes()).toEqual({ vm: true, baremetal: true });
  });

  it('reads a manifest without bmNodes as the vm plane alone', () => {
    writeManifest(JSON.stringify({ nodes: [{ name: 'gpu-1' }] }));
    expect(readAppliedPlanes()).toEqual({ vm: true, baremetal: false });
  });

  it('reads an empty vm roster beside machines as the bare-metal plane alone', () => {
    writeManifest(JSON.stringify({ nodes: [], bmNodes: [{ name: 'metal-1' }] }));
    expect(readAppliedPlanes()).toEqual({ vm: false, baremetal: true });
  });

  it('ignores a mode key an older manifest still carries', () => {
    writeManifest(JSON.stringify({ mode: 'baremetal', nodes: [{ name: 'gpu-1' }] }));
    expect(readAppliedPlanes()).toEqual({ vm: true, baremetal: false });
  });

  it('falls back to the vm plane when no manifest exists', () => {
    expect(readAppliedPlanes()).toEqual(VM_ONLY);
  });

  it('falls back to the vm plane when the manifest is not JSON', () => {
    writeManifest('not json');
    expect(readAppliedPlanes()).toEqual(VM_ONLY);
  });

  it('falls back to the vm plane when the rosters are not arrays', () => {
    writeManifest(JSON.stringify({ nodes: 'gpu-1', bmNodes: 3 }));
    expect(readAppliedPlanes()).toEqual(VM_ONLY);
  });
});

describe('planesEqual', () => {
  it('compares both booleans', () => {
    expect(planesEqual({ vm: true, baremetal: false }, VM_ONLY)).toBe(true);
    expect(planesEqual({ vm: true, baremetal: true }, VM_ONLY)).toBe(false);
    expect(planesEqual({ vm: false, baremetal: false }, VM_ONLY)).toBe(false);
  });
});
