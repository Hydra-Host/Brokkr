import { buildTelegrafFactory, type TelegrafFactoryHandle, type TelegrafFactoryOptions } from './telegraf-factory.js';

let handle: TelegrafFactoryHandle | null = null;
let pendingOptions: TelegrafFactoryOptions | null = null;

export function configureTelegrafFactory(options: TelegrafFactoryOptions): void {
  pendingOptions = options;
}

export function getTelegrafFactoryHandle(): TelegrafFactoryHandle {
  if (handle === null) {
    handle = buildTelegrafFactory(pendingOptions ?? {});
  }
  return handle;
}

export function resetTelegrafFactoryForTests(): void {
  handle = null;
  pendingOptions = null;
}
