export const SESSION_QUEUE_MAXSIZE = 256;

export interface CancelSignal {
  isSet(): boolean;
  wait(): Promise<void>;
}

export const QUEUE_GET_CANCELLED: unique symbol = Symbol('SessionQueue:getOrCancel:cancelled');
export type QueueGetCancelled = typeof QUEUE_GET_CANCELLED;

export interface SessionQueue<T = unknown> {
  putNowait(item: T): void;
  put(item: T, timeoutMs?: number): Promise<void>;
  get(): Promise<T>;
  getOrCancel(cancel: CancelSignal): Promise<T | QueueGetCancelled>;
  qsize(): number;
  readonly maxsize: number;
}

export class QueueFullError extends Error {
  constructor() {
    super('queue full');
    this.name = 'QueueFullError';
  }
}

export class QueuePutTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`queue put timed out after ${timeoutMs}ms`);
    this.name = 'QueuePutTimeoutError';
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = res;
      this.reject = rej;
    });
  }
}

export class BoundedAsyncQueue<T> implements SessionQueue<T> {
  readonly maxsize: number;
  private readonly items: T[] = [];
  private readonly getters: Array<Deferred<T>> = [];
  private readonly putters: Array<{ item: T; deferred: Deferred<void> }> = [];

  constructor(maxsize: number = SESSION_QUEUE_MAXSIZE) {
    this.maxsize = maxsize;
  }

  qsize(): number {
    return this.items.length;
  }

  putNowait(item: T): void {
    const waiter = this.getters.shift();
    if (waiter !== undefined) {
      waiter.resolve(item);
      return;
    }
    if (this.items.length >= this.maxsize) {
      throw new QueueFullError();
    }
    this.items.push(item);
  }

  async put(item: T, timeoutMs?: number): Promise<void> {
    const waiter = this.getters.shift();
    if (waiter !== undefined) {
      waiter.resolve(item);
      return;
    }
    if (this.items.length < this.maxsize) {
      this.items.push(item);
      return;
    }
    const deferred = new Deferred<void>();
    const pending = { item, deferred };
    this.putters.push(pending);
    if (timeoutMs === undefined) {
      await deferred.promise;
      return;
    }
    // Remove our putters entry on timeout so we're never woken later; QueuePutTimeoutError lets the dispatcher surface AgentNotResponsive.
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        deferred.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const idx = this.putters.indexOf(pending);
            if (idx >= 0) this.putters.splice(idx, 1);
            reject(new QueuePutTimeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async get(): Promise<T> {
    if (this.items.length > 0) {
      const item = this.items.shift() as T;
      const pending = this.putters.shift();
      if (pending !== undefined) {
        this.items.push(pending.item);
        pending.deferred.resolve();
      }
      return item;
    }
    const deferred = new Deferred<T>();
    this.getters.push(deferred);
    return deferred.promise;
  }

  async getOrCancel(cancel: CancelSignal): Promise<T | QueueGetCancelled> {
    if (cancel.isSet()) return QUEUE_GET_CANCELLED;
    if (this.items.length > 0) {
      const item = this.items.shift() as T;
      const pending = this.putters.shift();
      if (pending !== undefined) {
        this.items.push(pending.item);
        pending.deferred.resolve();
      }
      return item;
    }
    const deferred = new Deferred<T>();
    this.getters.push(deferred);
    // Invariant: a producer running between cancel-resolution and cleanup must not silently drop the item.
    const winner = await Promise.race([
      deferred.promise.then((value) => ({ kind: 'item' as const, value })),
      cancel.wait().then(() => ({ kind: 'cancel' as const })),
    ]);
    if (winner.kind === 'item') return winner.value;
    const idx = this.getters.indexOf(deferred);
    if (idx >= 0) {
      this.getters.splice(idx, 1);
      return QUEUE_GET_CANCELLED;
    }
    const orphaned = await deferred.promise;
    const otherWaiter = this.getters.shift();
    if (otherWaiter !== undefined) {
      otherWaiter.resolve(orphaned);
    } else {
      this.items.unshift(orphaned);
    }
    return QUEUE_GET_CANCELLED;
  }
}

export class CancelEvent {
  private signalled = false;
  private readonly waiters: Array<() => void> = [];

  isSet(): boolean {
    return this.signalled;
  }

  set(): void {
    if (this.signalled) return;
    this.signalled = true;
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const w of pending) w();
  }

  /** Pass an AbortSignal to detach the waiter when the caller loses an outer race — otherwise a long-lived session retains one resolver closure per wait() until teardown. */
  async wait(signal?: AbortSignal): Promise<void> {
    if (this.signalled || signal?.aborted === true) return;
    await new Promise<void>((resolve) => {
      const waiter = (): void => resolve();
      this.waiters.push(waiter);
      if (signal !== undefined) {
        signal.addEventListener(
          'abort',
          () => {
            const idx = this.waiters.indexOf(waiter);
            if (idx >= 0) this.waiters.splice(idx, 1);
            resolve();
          },
          { once: true },
        );
      }
    });
  }
}

export interface SessionHandle {
  deviceId: string;
  peerIp: string | null;
  agentVersion: string;
  readiness: string;
  connectedAt: number;
  queue: SessionQueue<unknown>;
  cancelled: CancelEvent;
  lastEnqueueTimeoutAt: number | null;
}

export interface CreateSessionHandleOptions {
  deviceId: string;
  peerIp?: string | null;
  agentVersion?: string;
  readiness?: string;
  connectedAt?: number;
  queue?: SessionQueue<unknown>;
}

export function createSessionHandle(opts: CreateSessionHandleOptions): SessionHandle {
  return {
    deviceId: opts.deviceId,
    peerIp: opts.peerIp ?? null,
    agentVersion: opts.agentVersion ?? '',
    readiness: opts.readiness ?? 'ready',
    connectedAt: opts.connectedAt ?? Date.now() / 1000,
    queue: opts.queue ?? new BoundedAsyncQueue<unknown>(SESSION_QUEUE_MAXSIZE),
    cancelled: new CancelEvent(),
    lastEnqueueTimeoutAt: null,
  };
}
