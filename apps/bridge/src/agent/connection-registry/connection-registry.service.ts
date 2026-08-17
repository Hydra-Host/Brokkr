// Multiple live sessions per device are allowed (N bridge endpoints can DNS-resolve to the same bridge); a different agentVersion on register cancels priors — one agent process per device, so a version change implies a stale stream.

import { Injectable } from '@nestjs/common';

import { createSessionHandle, type SessionHandle, type SessionQueue } from './connection-registry.types';

export type { CancelEvent } from './connection-registry.types';

export interface PickHandleCandidate {
  cancelled: boolean;
  lastEnqueueTimeoutAt: number | null;
}

export function pickPreferredHandle<T extends PickHandleCandidate>(
  handles: readonly T[],
  now: number,
  recentTimeoutWindowS: number,
): T | null {
  const hasRecentTimeout = (h: T): boolean =>
    h.lastEnqueueTimeoutAt !== null && now - h.lastEnqueueTimeoutAt < recentTimeoutWindowS;

  for (const handle of handles) {
    if (!handle.cancelled && !hasRecentTimeout(handle)) {
      return handle;
    }
  }
  for (const handle of handles) {
    if (!handle.cancelled) {
      return handle;
    }
  }
  return null;
}

const RECENT_TIMEOUT_WINDOW_S = 10.0;

class AsyncLock {
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.locked = false;
  }

  async run<R>(fn: () => Promise<R>): Promise<R> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

class WaitEvent {
  private signalled = false;
  private waiters: Array<() => void> = [];

  set(): void {
    this.signalled = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w();
  }

  clear(): void {
    this.signalled = false;
  }

  isSet(): boolean {
    return this.signalled;
  }

  async wait(timeoutMs: number): Promise<boolean> {
    if (this.signalled) return true;
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onSet = (): void => {
        if (timer !== null) clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(onSet);
      if (timeoutMs <= 0) {
        const idx = this.waiters.indexOf(onSet);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
        return;
      }
      timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onSet);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
    });
  }
}

function monotonicSec(): number {
  return performance.now() / 1000;
}

export interface RegisterOptions {
  agentVersion?: string;
  readiness?: string;
  peerIp?: string | null;
  queue?: SessionQueue<unknown>;
}

export interface WaitForRegistrationOptions {
  expectVersion?: string | null;
}

@Injectable()
export class ConnectionRegistry {
  private readonly sessions = new Map<string, SessionHandle[]>();
  private readonly waitEvents = new Map<string, WaitEvent>();
  private readonly lock = new AsyncLock();

  async register(deviceId: string, opts: RegisterOptions = {}): Promise<SessionHandle> {
    const handle = createSessionHandle({
      deviceId,
      peerIp: opts.peerIp ?? null,
      agentVersion: opts.agentVersion ?? '',
      readiness: opts.readiness ?? 'ready',
      queue: opts.queue,
    });
    await this.lock.run(async () => {
      let handles = this.sessions.get(deviceId);
      if (handles === undefined) {
        handles = [];
        this.sessions.set(deviceId, handles);
      }
      if (handle.agentVersion) {
        for (const prior of handles) {
          if (prior.agentVersion && prior.agentVersion !== handle.agentVersion) {
            prior.cancelled.set();
          }
        }
      }
      handles.push(handle);
      let event = this.waitEvents.get(deviceId);
      if (event === undefined) {
        event = new WaitEvent();
        this.waitEvents.set(deviceId, event);
      }
      event.set();
    });
    return handle;
  }

  async unregister(deviceId: string, handle: SessionHandle): Promise<void> {
    await this.lock.run(async () => {
      const handles = this.sessions.get(deviceId);
      if (handles === undefined) return;
      const idx = handles.indexOf(handle);
      if (idx < 0) return;
      handles.splice(idx, 1);
      if (handles.length === 0) {
        this.sessions.delete(deviceId);
        const event = this.waitEvents.get(deviceId);
        if (event !== undefined) event.clear();
      }
    });
  }

  get(deviceId: string): SessionHandle | null {
    const live = this.sessions.get(deviceId);
    if (live === undefined || live.length === 0) return null;
    const adapters = live.map((h) => ({
      cancelled: h.cancelled.isSet(),
      lastEnqueueTimeoutAt: h.lastEnqueueTimeoutAt,
      handle: h,
    }));
    const picked = pickPreferredHandle(adapters, monotonicSec(), RECENT_TIMEOUT_WINDOW_S);
    return picked === null ? null : picked.handle;
  }

  isConnected(deviceId: string): boolean {
    return this.get(deviceId) !== null;
  }

  deviceIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  async snapshotSessionHandles(): Promise<SessionHandle[]> {
    return this.lock.run(async () => {
      const out: SessionHandle[] = [];
      for (const handles of this.sessions.values()) {
        for (const handle of handles) out.push(handle);
      }
      return out;
    });
  }

  size(): number {
    return this.sessions.size;
  }

  sessionCount(deviceId: string): number {
    const handles = this.sessions.get(deviceId);
    return handles === undefined ? 0 : handles.length;
  }

  async waitForRegistration(
    deviceId: string,
    timeoutSec: number,
    opts: WaitForRegistrationOptions = {},
  ): Promise<SessionHandle | null> {
    const expectVersion = opts.expectVersion ?? null;
    const deadlineSec = monotonicSec() + timeoutSec;
    for (;;) {
      const lookup = await this.lock.run(async (): Promise<{ event: WaitEvent; match: SessionHandle | null }> => {
        let ev = this.waitEvents.get(deviceId);
        if (ev === undefined) {
          ev = new WaitEvent();
          this.waitEvents.set(deviceId, ev);
        }
        const handles = this.sessions.get(deviceId) ?? [];
        const match = handles.find(
          (h) => !h.cancelled.isSet() && (expectVersion === null || h.agentVersion === expectVersion),
        );
        if (match !== undefined) return { event: ev, match };
        ev.clear();
        return { event: ev, match: null };
      });
      if (lookup.match !== null) return lookup.match;
      const remainingMs = (deadlineSec - monotonicSec()) * 1000;
      if (remainingMs <= 0) return null;
      const fired = await lookup.event.wait(remainingMs);
      if (!fired) return null;
    }
  }
}

// Never reintroduce a free-function accessor — a second lazy singleton would split register/unregister across two maps and break dispatch.
