// Brokkr-live only: the deployed OS phones home via cloud-init, and the hub treats this call as a brokkr-live callback, never "provisioned".

import { create } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AgentConfig } from './config';
import { sleepWithAbort } from './connection/sleep';
import { getErrorMessage } from './errors';
import type { AgentService } from './gen/brokkr/agent/v1/agent_pb';
import { PhoneHomeRequestSchema } from './gen/brokkr/agent/v1/agent_pb';
import { makeLogger } from './logger';

type AgentServiceClient = Client<typeof AgentService>;

export type PhoneHomeClientProvider = () => AgentServiceClient | null;

const logger = makeLogger('phone-home');

const GATE_DIR = '/run/brokkr';
const GATE_PATH = `${GATE_DIR}/phone-home-fired`;
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const BOOT_ID_UNREADABLE_SENTINEL = 'unknown-boot';

const PHONE_HOME_RPC_TIMEOUT_MS = 10_000;

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

let phoneHomeSettled = false;
let inflightAttempt: Promise<void> | null = null;
let retryAbort: AbortController | null = null;

export interface PhoneHomeOptions {
  gatePath?: string;
  bootIdPath?: string;
  retryDelaysMs?: readonly number[];
}

async function readBootId(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function alreadyFiredThisBoot(gatePath: string, bootIdPath: string): Promise<boolean> {
  let stored: string;
  try {
    stored = (await readFile(gatePath, 'utf8')).trim();
  } catch {
    return false;
  }
  const current = await readBootId(bootIdPath);
  // On dev hosts /run can survive reboots — a rotated boot_id keeps a stale gate from suppressing firing.
  if (current === null) {
    if (stored === BOOT_ID_UNREADABLE_SENTINEL) return false;
    return stored.length > 0;
  }
  return stored === current;
}

async function writeGate(gatePath: string, bootIdPath: string): Promise<void> {
  const bootId = await readBootId(bootIdPath);
  try {
    await mkdir(dirname(gatePath), { recursive: true });
    await writeFile(gatePath, bootId ?? BOOT_ID_UNREADABLE_SENTINEL, { encoding: 'utf8' });
  } catch (err) {
    logger.warn('failed to write phone-home gate after success', {
      gate: gatePath,
      message: getErrorMessage(err),
    });
  }
}

async function runAttemptChain(
  getClient: PhoneHomeClientProvider,
  config: AgentConfig,
  opts: PhoneHomeOptions,
  signal: AbortSignal,
): Promise<void> {
  const gatePath = opts.gatePath ?? GATE_PATH;
  const bootIdPath = opts.bootIdPath ?? BOOT_ID_PATH;
  const retryDelays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;

  if (await alreadyFiredThisBoot(gatePath, bootIdPath)) {
    logger.info('phone-home already fired this boot — skipping', { gate: gatePath });
    phoneHomeSettled = true;
    return;
  }

  const bootId = (await readBootId(bootIdPath)) ?? BOOT_ID_UNREADABLE_SENTINEL;

  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) return;
    const client = getClient();
    if (client === null) {
      logger.warn('phone-home: no live bridge client available', { retry: attempt });
    } else {
      try {
        await client.phoneHome(create(PhoneHomeRequestSchema, { deviceId: config.device_id, bootId }), {
          timeoutMs: PHONE_HOME_RPC_TIMEOUT_MS,
        });
        logger.info('phone-home sent over gRPC', { device_id: config.device_id });
        await writeGate(gatePath, bootIdPath);
        phoneHomeSettled = true;
        return;
      } catch (error) {
        logger.warn('phone-home over gRPC failed', {
          err: getErrorMessage(error),
          retry: attempt,
          retries_remaining: retryDelays.length - attempt,
        });
      }
    }

    if (attempt >= retryDelays.length) {
      logger.warn('phone-home gave up after all retries this boot', {
        device_id: config.device_id,
        boot_id: bootId,
        attempts: retryDelays.length + 1,
      });
      return;
    }

    await sleepWithAbort(retryDelays[attempt]!, signal);
  }
}

export async function firePhoneHomeOverGrpc(
  getClient: PhoneHomeClientProvider,
  config: AgentConfig,
  opts: PhoneHomeOptions = {},
): Promise<void> {
  if (phoneHomeSettled) return;

  if (inflightAttempt) {
    await inflightAttempt;
    return;
  }

  retryAbort = new AbortController();
  const attempt = runAttemptChain(getClient, config, opts, retryAbort.signal).finally(() => {
    if (!phoneHomeSettled) inflightAttempt = null;
    retryAbort = null;
  });
  inflightAttempt = attempt;
  await attempt;
}

export function cancelPhoneHomeRetry(): void {
  if (retryAbort) {
    retryAbort.abort();
    retryAbort = null;
  }
}
