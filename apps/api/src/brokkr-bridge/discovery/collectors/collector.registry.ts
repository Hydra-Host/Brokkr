import { Injectable } from '@nestjs/common';
import type { CollectorHandler, CollectorNameV2 } from './collector.types';

@Injectable()
export class CollectorRegistry {
  private readonly handlers = new Map<CollectorNameV2, CollectorHandler<unknown>>();

  register<T>(handler: CollectorHandler<T>): void {
    if (this.handlers.has(handler.name)) {
      throw new Error(`Duplicate CollectorHandler registration: ${handler.name}`);
    }
    this.handlers.set(handler.name, handler as CollectorHandler<unknown>);
  }

  get(name: string): CollectorHandler<unknown> | undefined {
    return this.handlers.get(name as CollectorNameV2);
  }

  has(name: string): boolean {
    return this.handlers.has(name as CollectorNameV2);
  }

  all(): CollectorHandler<unknown>[] {
    return [...this.handlers.values()];
  }

  names(): CollectorNameV2[] {
    return [...this.handlers.keys()];
  }
}
