import { Logger } from '@nestjs/common';

import { ipmitoolBin } from './command.js';
import type { IPMIDevice } from './device.js';
import type { IPMIResult } from './result.js';
import { resultError } from './result.js';
import { run as transportRun } from './transport.js';

const logger = new Logger('adapter-ipmi-rmcp-plus');
const PROBE_TIMEOUT = 20;

export interface ChannelAccessOutcome {
  channel: number;
  lanOk: boolean;
  lanplusOk: boolean;
  uid: number | null;
  blocked: boolean;
  reasons: string[];
  action: string | null;
  repaired: boolean | null;
  before: Record<string, string> | null;
  after: Record<string, string> | null;
  error: string | null;
}

type OutcomeInit = Partial<ChannelAccessOutcome> & Pick<ChannelAccessOutcome, 'channel' | 'lanOk' | 'lanplusOk'>;

function outcome(init: OutcomeInit): ChannelAccessOutcome {
  return {
    uid: null,
    blocked: false,
    reasons: [],
    action: null,
    repaired: null,
    before: null,
    after: null,
    error: null,
    ...init,
  };
}

export type RunOp = (device: IPMIDevice, iface: string, op: readonly string[], timeout?: number) => Promise<IPMIResult>;

async function runOp(
  device: IPMIDevice,
  iface: string,
  op: readonly string[],
  timeout = PROBE_TIMEOUT,
): Promise<IPMIResult> {
  const argv = [
    ipmitoolBin(),
    '-H',
    device.ip,
    '-U',
    device.username,
    '-P',
    device.password,
    '-p',
    String(device.port),
    '-I',
    iface,
    ...op,
  ];
  return transportRun(argv, device.password, timeout, { jobId: device.jobId });
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function findUid(stdout: string, username: string): number | null {
  for (const line of splitLines(stdout)) {
    const fields = line.split(/\s+/).filter((t) => t !== '');
    const id = fields[0];
    if (fields.length >= 2 && id !== undefined && /^\d+$/.test(id) && fields[1] === username) {
      return parseInt(id, 10);
    }
  }
  return null;
}

export function parseGetaccess(stdout: string): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const line of splitLines(stdout)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    acc[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return acc;
}

export function blockReasons(access: Record<string, string>): string[] {
  const reasons: string[] = [];
  if (!(access['IPMI Messaging'] ?? '').toLowerCase().includes('enabled')) {
    reasons.push('IPMI messaging disabled on channel');
  }
  const priv = (access['Privilege Level'] ?? '').toUpperCase();
  if (!priv.includes('ADMINISTRATOR')) {
    reasons.push(`privilege limit ${priv || 'unknown'} below ADMINISTRATOR`);
  }
  return reasons;
}

export interface RepairLanplusOptions {
  channel?: number;
  dryRun?: boolean;
}

export async function repairLanplusAccess(
  device: IPMIDevice,
  opts: RepairLanplusOptions = {},
  run: RunOp = runOp,
): Promise<ChannelAccessOutcome> {
  const channel = opts.channel ?? 1;
  const dryRun = opts.dryRun ?? false;
  const jobId = device.jobId;

  const lanplus = await run(device, 'lanplus', ['chassis', 'status']);
  if (lanplus.ok) {
    logger.debug(`lanplus already functional on ${device.ip}; nothing to repair`, jobId);
    return outcome({ channel, lanOk: true, lanplusOk: true });
  }

  const lan = await run(device, 'lan', ['chassis', 'status']);
  if (!lan.ok) {
    logger.warn(`lan access itself failing on ${device.ip} — different problem: ${resultError(lan)}`, jobId);
    return outcome({ channel, lanOk: false, lanplusOk: false, error: `lan access failed: ${resultError(lan)}` });
  }

  logger.log(`lanplus fails while lan works on ${device.ip}; inspecting channel ${channel} access`, jobId);

  const users = await run(device, 'lan', ['user', 'list', String(channel)]);
  if (!users.ok) {
    return outcome({ channel, lanOk: true, lanplusOk: false, error: `user list failed: ${resultError(users)}` });
  }
  const uid = findUid(users.stdout, device.username);
  if (uid === null) {
    return outcome({
      channel,
      lanOk: true,
      lanplusOk: false,
      error: `could not resolve uid for '${device.username}' on channel ${channel}`,
    });
  }

  const access = await run(device, 'lan', ['channel', 'getaccess', String(channel), String(uid)]);
  if (!access.ok) {
    return outcome({ channel, lanOk: true, lanplusOk: false, uid, error: `getaccess failed: ${resultError(access)}` });
  }
  const before = parseGetaccess(access.stdout);
  const reasons = blockReasons(before);

  if (reasons.length === 0) {
    return outcome({
      channel,
      lanOk: true,
      lanplusOk: false,
      uid,
      before,
      error:
        'user/channel access looks fine — lanplus failure is elsewhere (cipher suites disabled or v2.0 unsupported)',
    });
  }

  const action = `channel setaccess ${channel} ${uid} ipmi=on privilege=4`;
  if (dryRun) {
    return outcome({ channel, lanOk: true, lanplusOk: false, uid, blocked: true, reasons, action, before });
  }

  logger.log(`repairing channel access on ${device.ip}: ${action} (${reasons.join('; ')})`, jobId);
  const setaccess = await run(device, 'lan', [
    'channel',
    'setaccess',
    String(channel),
    String(uid),
    'ipmi=on',
    'privilege=4',
  ]);
  if (!setaccess.ok) {
    return outcome({
      channel,
      lanOk: true,
      lanplusOk: false,
      uid,
      blocked: true,
      reasons,
      action,
      before,
      repaired: false,
      error: `setaccess failed: ${resultError(setaccess)}`,
    });
  }

  const afterProbe = await run(device, 'lan', ['channel', 'getaccess', String(channel), String(uid)]);
  const after = afterProbe.ok ? parseGetaccess(afterProbe.stdout) : null;

  const verify = await run(device, 'lanplus', ['chassis', 'status']);
  let error: string | null;
  if (verify.ok) {
    logger.log(`channel access repaired on ${device.ip}; lanplus now functional`, jobId);
    error = null;
  } else {
    logger.warn(`setaccess applied on ${device.ip} but lanplus still fails: ${resultError(verify)}`, jobId);
    error = `setaccess applied but lanplus still fails (cause elsewhere): ${resultError(verify)}`;
  }

  return outcome({
    channel,
    lanOk: true,
    lanplusOk: verify.ok,
    uid,
    blocked: true,
    reasons,
    action,
    before,
    after,
    repaired: verify.ok,
    error,
  });
}
