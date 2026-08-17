// Worker factories run before NestFactory.create builds the DI graph, so they can't inject the processor; awaitBullmqProcessor() resolves lazily if a job arrives while Nest is still mid-boot.

import type { BullmqProcessorService } from './handlers.service.js';

let instance: BullmqProcessorService | null = null;
let waiters: Array<(processor: BullmqProcessorService) => void> = [];

export function setBullmqProcessor(processor: BullmqProcessorService): void {
  instance = processor;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) {
    resolve(processor);
  }
}

export function awaitBullmqProcessor(): Promise<BullmqProcessorService> {
  if (instance !== null) return Promise.resolve(instance);
  return new Promise<BullmqProcessorService>((resolve) => {
    waiters.push(resolve);
  });
}

export function peekBullmqProcessor(): BullmqProcessorService | null {
  return instance;
}

export function resetBullmqProcessorForTests(): void {
  instance = null;
  waiters = [];
}
