import { describe, expect, it, vi } from 'vitest';

import type { IPMIDevice } from '../device.js';
import type { IPMIResult } from '../result.js';
import type { RunOp } from '../rmcp-plus.js';
import { repairLanplusAccess } from '../rmcp-plus.js';

const device: IPMIDevice = {
  ip: '10.0.0.5',
  username: 'ADMIN',
  password: 'secret',
  port: 623,
  cipher: null,
  jobId: 'job-1',
};

function ok(stdout = ''): IPMIResult {
  return { ok: true, stdout, stderr: '', returncode: 0, command: [], cipherUsed: null, durationMs: 1, timedOut: false };
}

function fail(stderr = 'boom', returncode: number | null = 1): IPMIResult {
  return { ok: false, stdout: '', stderr, returncode, command: [], cipherUsed: null, durationMs: 1, timedOut: false };
}

const USER_LIST =
  '1   root             true    true       true       ADMINISTRATOR\n2   ADMIN            true    true       true       ADMINISTRATOR\n';

const BLOCKED_ACCESS = 'IPMI Messaging        : disabled\nPrivilege Level       : USER\n';
const CLEAN_ACCESS = 'IPMI Messaging        : enabled\nPrivilege Level       : ADMINISTRATOR\n';

function scriptedRunOp(script: Record<string, IPMIResult | IPMIResult[]>): {
  run: RunOp;
  calls: Array<{ iface: string; op: readonly string[] }>;
} {
  const calls: Array<{ iface: string; op: readonly string[] }> = [];
  const cursors: Record<string, number> = {};
  const run: RunOp = vi.fn(async (_device, iface, op) => {
    calls.push({ iface, op });
    const key = `${iface} ${op[0]} ${op[1]}`;
    const entry = script[key];
    if (entry === undefined) throw new Error(`unscripted op: ${key} (${JSON.stringify(op)})`);
    if (Array.isArray(entry)) {
      const i = cursors[key] ?? 0;
      cursors[key] = i + 1;
      const r = entry[Math.min(i, entry.length - 1)];
      if (r === undefined) throw new Error(`empty script for ${key}`);
      return r;
    }
    return entry;
  });
  return { run, calls };
}

describe('repairLanplusAccess orchestration', () => {
  it('short-circuits with no setaccess when lanplus is already functional', async () => {
    const { run, calls } = scriptedRunOp({ 'lanplus chassis status': ok() });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result).toMatchObject({ channel: 1, lanOk: true, lanplusOk: true, blocked: false, repaired: null });
    expect(result.action).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.op.includes('setaccess'))).toBe(false);
  });

  it('returns lanOk:false when lan itself also fails', async () => {
    const { run, calls } = scriptedRunOp({
      'lanplus chassis status': fail('lanplus down'),
      'lan chassis status': fail('lan down'),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.lanOk).toBe(false);
    expect(result.lanplusOk).toBe(false);
    expect(result.error).toContain('lan access failed');
    expect(calls.some((c) => c.op.includes('setaccess'))).toBe(false);
  });

  it('returns an error when the user list lookup fails', async () => {
    const { run } = scriptedRunOp({
      'lanplus chassis status': fail(),
      'lan chassis status': ok(),
      'lan user list': fail('no users'),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.lanOk).toBe(true);
    expect(result.lanplusOk).toBe(false);
    expect(result.error).toContain('user list failed');
  });

  it('returns an error when the uid cannot be resolved', async () => {
    const { run } = scriptedRunOp({
      'lanplus chassis status': fail(),
      'lan chassis status': ok(),
      'lan user list': ok('1 root true true true ADMINISTRATOR\n'),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.uid).toBeNull();
    expect(result.error).toContain("could not resolve uid for 'ADMIN'");
  });

  it('returns an error when getaccess fails', async () => {
    const { run } = scriptedRunOp({
      'lanplus chassis status': fail(),
      'lan chassis status': ok(),
      'lan user list': ok(USER_LIST),
      'lan channel getaccess': fail('getaccess boom'),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.uid).toBe(2);
    expect(result.error).toContain('getaccess failed');
  });

  it("returns the 'elsewhere' error without mutating when block reasons are empty", async () => {
    const { run, calls } = scriptedRunOp({
      'lanplus chassis status': fail(),
      'lan chassis status': ok(),
      'lan user list': ok(USER_LIST),
      'lan channel getaccess': ok(CLEAN_ACCESS),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.blocked).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.error).toContain('lanplus failure is elsewhere');
    expect(result.repaired).toBeNull();
    expect(calls.some((c) => c.op.includes('setaccess'))).toBe(false);
  });

  it('plans but does not issue setaccess on dryRun', async () => {
    const { run, calls } = scriptedRunOp({
      'lanplus chassis status': fail(),
      'lan chassis status': ok(),
      'lan user list': ok(USER_LIST),
      'lan channel getaccess': ok(BLOCKED_ACCESS),
    });

    const result = await repairLanplusAccess(device, { dryRun: true }, run);

    expect(result.blocked).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.action).toBe('channel setaccess 1 2 ipmi=on privilege=4');
    expect(result.repaired).toBeNull();
    expect(calls.some((c) => c.op.includes('setaccess'))).toBe(false);
  });

  it('issues the exact setaccess argv only when block reasons are non-empty, then reports repaired on verify success', async () => {
    const { run, calls } = scriptedRunOp({
      'lanplus chassis status': [fail(), ok()],
      'lan chassis status': ok(),
      'lan user list': ok(USER_LIST),
      'lan channel getaccess': ok(BLOCKED_ACCESS),
      'lan channel setaccess': ok(),
    });

    const result = await repairLanplusAccess(device, { channel: 3 }, run);

    const setaccessCall = calls.find((c) => c.op.includes('setaccess'));
    expect(setaccessCall).toBeDefined();
    expect(setaccessCall?.iface).toBe('lan');
    expect(setaccessCall?.op).toEqual(['channel', 'setaccess', '3', '2', 'ipmi=on', 'privilege=4']);

    expect(result.repaired).toBe(true);
    expect(result.lanplusOk).toBe(true);
    expect(result.error).toBeNull();
    expect(result.after).toEqual({ 'IPMI Messaging': 'disabled', 'Privilege Level': 'USER' });
  });

  it('does not classify a failed setaccess as success', async () => {
    const { run, calls } = scriptedRunOp({
      'lanplus chassis status': fail(),
      'lan chassis status': ok(),
      'lan user list': ok(USER_LIST),
      'lan channel getaccess': ok(BLOCKED_ACCESS),
      'lan channel setaccess': fail('permission denied'),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.repaired).toBe(false);
    expect(result.lanplusOk).toBe(false);
    expect(result.error).toContain('setaccess failed');
    expect(calls.filter((c) => c.iface === 'lanplus')).toHaveLength(1);
  });

  it('reports error (not repaired) when setaccess succeeds but lanplus still fails on verify', async () => {
    const { run } = scriptedRunOp({
      'lanplus chassis status': [fail(), fail('still broken')],
      'lan chassis status': ok(),
      'lan user list': ok(USER_LIST),
      'lan channel getaccess': ok(BLOCKED_ACCESS),
      'lan channel setaccess': ok(),
    });

    const result = await repairLanplusAccess(device, {}, run);

    expect(result.repaired).toBe(false);
    expect(result.lanplusOk).toBe(false);
    expect(result.error).toContain('setaccess applied but lanplus still fails');
  });
});
