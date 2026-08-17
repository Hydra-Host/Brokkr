import { buildBaseCommand } from '../command.js';
import type { IPMIDevice } from '../device.js';
import type { IPMIResult } from '../result.js';
import { run as transportRun } from '../transport.js';
import { IPMIValidationError } from '../validation.js';

const CHANNEL_MIN = 1;
const CHANNEL_MAX = 16;
const USER_ID_MIN = 1;
const USER_ID_MAX = 64;

const STR_INT_RE = /^[+-]?\d(_?\d)*$/;

export interface SolOptions {
  timeout?: number;
}

function toInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not an int');
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!STR_INT_RE.test(trimmed)) throw new TypeError('not an int');
    return parseInt(trimmed.replace(/_/g, ''), 10);
  }
  throw new TypeError('not an int');
}

export function validateChannel(channel: unknown): number {
  let ch: number;
  try {
    ch = toInt(channel);
  } catch {
    throw new IPMIValidationError(`Invalid channel: ${JSON.stringify(channel)}`);
  }
  if (ch < CHANNEL_MIN || ch > CHANNEL_MAX) {
    throw new IPMIValidationError(`Channel must be between ${CHANNEL_MIN} and ${CHANNEL_MAX} (got ${ch})`);
  }
  return ch;
}

export function validateUserId(userId: unknown): number {
  let uid: number;
  try {
    uid = toInt(userId);
  } catch {
    throw new IPMIValidationError(`Invalid user_id: ${JSON.stringify(userId)}`);
  }
  if (uid < USER_ID_MIN || uid > USER_ID_MAX) {
    throw new IPMIValidationError(`user_id must be between ${USER_ID_MIN} and ${USER_ID_MAX} (got ${uid})`);
  }
  return uid;
}

export async function solInfo(device: IPMIDevice, channel: number, opts: SolOptions = {}): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const ch = validateChannel(channel);
  const command = [...buildBaseCommand(device), 'sol', 'info', String(ch)];
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export async function solSetEnabled(
  device: IPMIDevice,
  enabled: boolean,
  channel: number,
  opts: SolOptions = {},
): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const ch = validateChannel(channel);
  const flag = enabled ? 'true' : 'false';
  const command = [...buildBaseCommand(device), 'sol', 'set', 'enabled', flag, String(ch)];
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export async function solPayloadStatus(
  device: IPMIDevice,
  channel: number,
  userId: number,
  opts: SolOptions = {},
): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const ch = validateChannel(channel);
  const uid = validateUserId(userId);
  const command = [...buildBaseCommand(device), 'sol', 'payload', 'status', String(ch), String(uid)];
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export async function solPayloadEnable(
  device: IPMIDevice,
  channel: number,
  userId: number,
  opts: SolOptions = {},
): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 30;
  const ch = validateChannel(channel);
  const uid = validateUserId(userId);
  const command = [...buildBaseCommand(device), 'sol', 'payload', 'enable', String(ch), String(uid)];
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}

export async function solDeactivate(device: IPMIDevice, opts: SolOptions = {}): Promise<IPMIResult> {
  const timeout = opts.timeout ?? 15;
  const command = [...buildBaseCommand(device), 'sol', 'deactivate'];
  return transportRun(command, device.password, timeout, { cipherUsed: device.cipher, jobId: device.jobId });
}
