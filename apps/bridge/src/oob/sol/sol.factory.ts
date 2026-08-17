import { spawn } from 'node:child_process';

import { Injectable } from '@nestjs/common';

import { RedisService } from '../../common/redis/redis.service.js';
import { ContextLogger } from '../../logger/logger.service.js';
import { getCipherForDevice } from '../ipmi/cipher.js';
import { buildBaseCommand } from '../ipmi/command.js';
import { solDeactivate as adapterSolDeactivate } from '../ipmi/handlers/sol.js';
import { ipmiPingOutcome } from '../ipmi/ping.js';
import { createSolService, SOLService, type SOLServiceDeps } from './sol.service.js';
import type { IPMIDevice as SolIPMIDevice, SolStream } from './sol.types.js';

async function defaultPingFn(ipAddress: string, port: number, jobId: string): Promise<Record<string, unknown>> {
  const outcome = await ipmiPingOutcome(ipAddress, { port, timeout: 2.0, jobId });
  if (outcome === 'reachable') {
    return { result: 'success', response: `IPMI ping successful - BMC is reachable on ${ipAddress}:${port}` };
  }
  if (outcome === 'timeout') {
    return { result: 'failure', response: `IPMI ping timeout - no response from ${ipAddress}:${port} within 2s` };
  }
  return { result: 'failure', response: `IPMI ping failed - no response from ${ipAddress}:${port}` };
}

async function* defaultStreamFactory(device: SolIPMIDevice): SolStream {
  const cmd = [...buildBaseCommand(device), 'sol', 'activate'];
  const [bin, ...args] = cmd;
  if (bin === undefined) {
    return;
  }

  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const chunks: Buffer[] = [];
  let ended = false;
  let notify: (() => void) | null = null;
  const wake = (): void => {
    const fn = notify;
    notify = null;
    if (fn !== null) fn();
  };
  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    wake();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', () => {
    ended = true;
    wake();
  });
  child.on('error', () => {
    ended = true;
    wake();
  });

  try {
    for (;;) {
      const next = chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (ended) {
        break;
      }
      const got = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          notify = null;
          resolve(false);
        }, 2000);
        notify = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      if (!got) {
        yield Buffer.alloc(0);
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, 5000);
      killTimer.unref();
    }
  }
}

@Injectable()
export class SolServiceFactory {
  constructor(
    private readonly redis: RedisService,
    private readonly logger: ContextLogger,
  ) {}

  async create(jobId: string): Promise<SOLService> {
    const redisClient = this.redis.connection;
    const deps: SOLServiceDeps = {
      cache: {
        rpush: (key, values, j) => redisClient.rpush(key, [...values], j),
        expire: (key, seconds, j) => redisClient.expire(key, seconds, j),
      },
      getCipher: (device, deviceId) => getCipherForDevice(redisClient, device, deviceId ?? null),
      solDeactivateFn: (device) => adapterSolDeactivate(device),
      pingFn: defaultPingFn,
      streamFactory: defaultStreamFactory,
      logger: this.logger,
    };
    return createSolService(jobId, deps);
  }
}
