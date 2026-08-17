export { AES_KEY_SIZE, KEY_SIZE, NONCE_SIZE, TAG_SIZE } from '@repo/crypto';

export interface SealOpenErrorInit {
  zoneId?: string | null;
  jobId?: string | null;
  direction?: string | null;
  reason?: string | null;
}

export class SealOpenError extends Error {
  zoneId: string | null;
  jobId: string | null;
  direction: string | null;
  reason: string | null;

  constructor(message = 'seal/open failed', init: SealOpenErrorInit = {}) {
    super(message);
    this.name = 'SealOpenError';
    this.zoneId = init.zoneId ?? null;
    this.jobId = init.jobId ?? null;
    this.direction = init.direction ?? null;
    this.reason = init.reason ?? null;
  }
}

export class SealKeyUnknownError extends SealOpenError {
  constructor(message = 'seal key unknown', init: SealOpenErrorInit = {}) {
    super(message, init);
    this.name = 'SealKeyUnknownError';
  }
}
