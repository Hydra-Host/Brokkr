import { Injectable } from '@nestjs/common';

import type { SagaDef } from './saga.types';

export function assertRecoveryTargetsResolve(saga: SagaDef): void {
  const stepNames = new Set(saga.steps.map((step) => step.name));
  for (const step of saga.steps) {
    for (const recovery of step.recovery ?? []) {
      if (!stepNames.has(recovery.rewindTo)) {
        throw new Error(
          `Saga '${saga.name}' step '${step.name}' has recovery rewindTo '${recovery.rewindTo}' that matches no declared step`,
        );
      }
    }
  }
}

@Injectable()
export class SagaRegistryService {
  private readonly defs = new Map<string, SagaDef>();

  register(saga: SagaDef): void {
    if (this.defs.has(saga.name)) {
      throw new Error(`Saga '${saga.name}' is already registered`);
    }
    assertRecoveryTargetsResolve(saga);
    this.defs.set(saga.name, saga);
  }

  getSagaDef(name: string): SagaDef | null {
    return this.defs.get(name) ?? null;
  }

  list(): SagaDef[] {
    return Array.from(this.defs.values());
  }

  keys(): string[] {
    return Array.from(this.defs.keys());
  }

  clear(): void {
    this.defs.clear();
  }
}

const defaultRegistry = new SagaRegistryService();

export function registerSagaDef(saga: SagaDef): void {
  defaultRegistry.register(saga);
}

export function getSagaDef(name: string): SagaDef | null {
  return defaultRegistry.getSagaDef(name);
}

export function listSagaDefs(): SagaDef[] {
  return defaultRegistry.list();
}

export function clearSagaRegistry(): void {
  defaultRegistry.clear();
}
