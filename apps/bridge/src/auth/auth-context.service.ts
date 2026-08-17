// Set by the gRPC auth interceptor at RPC entry so handlers don't trust the payload's claimed device_id.

import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';

import type { AuthSubject } from './agent-token.service';

const storage = new AsyncLocalStorage<AuthSubject>();

export function currentSubject(): AuthSubject | null {
  return storage.getStore() ?? null;
}

export function currentDeviceId(): string | null {
  const subject = storage.getStore();
  if (subject !== undefined && subject.kind === 'device') {
    return subject.deviceId;
  }
  return null;
}

export function bindSubject<T>(subject: AuthSubject, fn: () => T): T {
  return storage.run(subject, fn);
}

@Injectable()
export class AuthContextService {
  currentSubject(): AuthSubject | null {
    return currentSubject();
  }

  currentDeviceId(): string | null {
    return currentDeviceId();
  }

  bind<T>(subject: AuthSubject, fn: () => Promise<T>): Promise<T> {
    return bindSubject(subject, fn);
  }
}
