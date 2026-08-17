import * as snmp from 'net-snmp';

import { NIL_JOB_ID } from '../logger/context/logging-context.constants.js';
import { AuthData } from './auth.js';
import { defaultSnmpLogger, SnmpLogger } from './snmp-logger.js';

export interface SessionOptions {
  readonly timeoutMs: number;
  readonly retries: number;
}

const STRICT_INT_PATTERN = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

function parseStrictInt(name: string, value: string): number {
  if (!STRICT_INT_PATTERN.test(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value.replace(/_/g, ''), 10);
}

class AsyncSemaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 0) {
      throw new Error('Semaphore initial value must be >= 0');
    }
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.permits += 1;
  }
}

export class SnmpEngine {
  private closed = false;
  private started = false;
  private readonly operationSemaphore: AsyncSemaphore;
  private readonly logger: SnmpLogger;

  constructor(logger: SnmpLogger = defaultSnmpLogger()) {
    const raw = process.env.SNMP_MAX_CONCURRENT_OPS ?? '10';
    this.operationSemaphore = new AsyncSemaphore(parseStrictInt('SNMP_MAX_CONCURRENT_OPS', raw));
    this.logger = logger;
  }

  private ensureLive(): void {
    if (this.closed) {
      throw new Error('SnmpEngine is closed — call start() before using');
    }
  }

  async acquire<T>(fn: () => Promise<T>): Promise<T> {
    await this.operationSemaphore.acquire();
    try {
      return await fn();
    } finally {
      this.operationSemaphore.release();
    }
  }

  createSession(target: string, port: number, authData: AuthData, options: SessionOptions): snmp.Session {
    this.ensureLive();
    const sessionOptions = { port, timeout: options.timeoutMs, retries: options.retries };
    return authData.kind === 'community'
      ? snmp.createSession(target, authData.community, { ...sessionOptions, version: authData.version })
      : snmp.createV3Session(target, authData.user, sessionOptions);
  }

  async start(): Promise<void> {
    this.closed = false;
    this.ensureLive();
    this.started = true;
    await this.logger.info('SNMP engine started', { jobId: NIL_JOB_ID });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.started = false;
    await this.logger.info('SNMP engine closed', { jobId: NIL_JOB_ID });
  }

  isClosed(): boolean {
    return this.closed;
  }

  isStarted(): boolean {
    return this.started;
  }
}

let instance: SnmpEngine | null = null;

export function getSnmpEngine(): SnmpEngine {
  if (instance === null) {
    instance = new SnmpEngine();
  }
  return instance;
}

export function resetForTests(): void {
  instance = null;
}
