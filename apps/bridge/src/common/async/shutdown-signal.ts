export class ShutdownRequested extends Error {
  constructor(message = 'bridge shutdown requested') {
    super(message);
    this.name = 'ShutdownRequested';
  }
}

// BullmqModule is not @Global, so a long in-flight saga step cannot reach the supervisor's
// AbortController through DI; the running supervisor publishes its signal here instead.
let shutdownSignal: AbortSignal | undefined;

export function setShutdownSignal(signal: AbortSignal | undefined): void {
  shutdownSignal = signal;
}

export function getShutdownSignal(): AbortSignal | undefined {
  return shutdownSignal;
}
