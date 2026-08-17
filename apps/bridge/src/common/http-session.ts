import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Agent, type Dispatcher, fetch as undiciFetch } from 'undici';

const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_KEEPALIVE_TIMEOUT_MS = 90_000;
const DEFAULT_CONNECTIONS_PER_ORIGIN = 5;
const DEFAULT_MAX_ORIGINS = 80;

export interface HttpSessionOptions {
  connectionsPerOrigin?: number;
  maxOrigins?: number;
  totalTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  rejectUnauthorized?: boolean;
}

export function createSharedAgent(options: HttpSessionOptions = {}): Agent {
  const connections = options.connectionsPerOrigin ?? DEFAULT_CONNECTIONS_PER_ORIGIN;
  const maxOrigins = options.maxOrigins ?? DEFAULT_MAX_ORIGINS;
  const totalTimeout = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const keepAlive = options.keepAliveTimeoutMs ?? DEFAULT_KEEPALIVE_TIMEOUT_MS;
  const rejectUnauthorized = options.rejectUnauthorized ?? true;
  return new Agent({
    connections,
    maxOrigins,
    keepAliveTimeout: keepAlive,
    headersTimeout: totalTimeout,
    bodyTimeout: totalTimeout,
    pipelining: 0,
    connect: { rejectUnauthorized },
  });
}

export class SharedHttpSession {
  private agent: Agent;
  private isClosed = false;
  private readonly totalTimeoutMs: number;

  constructor(options: HttpSessionOptions = {}) {
    this.agent = createSharedAgent(options);
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get dispatcher(): Dispatcher {
    return this.agent;
  }

  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    if (this.isClosed) {
      throw new Error('Shared HTTP session is closed');
    }
    const signal = init.signal ?? AbortSignal.timeout(this.totalTimeoutMs);
    const response = await undiciFetch(input, {
      ...init,
      signal,
      dispatcher: this.agent,
    } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    await this.agent.close();
  }
}

let sharedSession: SharedHttpSession | null = null;

export function getSharedSession(): SharedHttpSession {
  if (sharedSession === null || sharedSession.closed) {
    sharedSession = new SharedHttpSession();
  }
  return sharedSession;
}

export async function closeSharedSession(): Promise<void> {
  if (sharedSession !== null && !sharedSession.closed) {
    await sharedSession.close();
  }
  sharedSession = null;
}

export const HTTP_SESSION = Symbol('HTTP_SESSION');

@Injectable()
export class HttpSessionService implements OnModuleDestroy {
  private readonly session: SharedHttpSession;

  constructor(options: HttpSessionOptions = {}) {
    this.session = new SharedHttpSession(options);
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    return this.session.fetch(input, init);
  }

  get dispatcher(): Dispatcher {
    return this.session.dispatcher;
  }

  get closed(): boolean {
    return this.session.closed;
  }

  async close(): Promise<void> {
    await this.session.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
