import type { BmcSecretSource } from '../monitoring/common/bmc-credentials-lookup.service.js';

export class BmcSecretSourceNotBoundError extends Error {
  constructor() {
    super(
      'BMC secret source holder not populated; AppModule must call setBmcSecretSource ' +
        'via an OnApplicationBootstrap hook before any DeviceCredentialResolver or telegraf ' +
        'cred consumer fires.',
    );
    this.name = 'BmcSecretSourceNotBoundError';
  }
}

let source: BmcSecretSource | null = null;

export function setBmcSecretSource(value: BmcSecretSource): void {
  source = value;
}

export function getBmcSecretSourceOrThrow(): BmcSecretSource {
  if (source === null) {
    throw new BmcSecretSourceNotBoundError();
  }
  return source;
}

export function resetBmcSecretSourceForTests(): void {
  source = null;
}
