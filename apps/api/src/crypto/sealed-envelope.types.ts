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

  constructor(message = 'seal/open failed', init: SealOpenErrorInit = {}, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SealOpenError';
    this.zoneId = init.zoneId ?? null;
    this.jobId = init.jobId ?? null;
    this.direction = init.direction ?? null;
    this.reason = init.reason ?? null;
  }
}

export class SealKeyUnknownError extends SealOpenError {
  constructor(message = 'seal key unknown', init: SealOpenErrorInit = {}) {
    super(message, { ...init, reason: 'key_unknown' });
    this.name = 'SealKeyUnknownError';
  }
}

// Sealed iff `envelope_v` present — must match the bridge's detection.
export function isSealedEnvelope(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'envelope_v' in data;
}
