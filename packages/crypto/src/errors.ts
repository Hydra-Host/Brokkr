export type SealDirection = 'hub_to_bridge' | 'bridge_to_hub';

export interface SealErrorContext {
  zoneId?: string;
  jobId?: string;
  direction?: SealDirection;
}

// Metric label `reason="tamper"`. Covers AES-GCM tag mismatch and malformed inputs; message never carries key material or ciphertext.
export class SealOpenError extends Error {
  readonly zoneId?: string;
  readonly jobId?: string;
  readonly direction?: SealDirection;

  constructor(message = 'seal/open failed', context: SealErrorContext = {}, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'SealOpenError';
    this.zoneId = context.zoneId;
    this.jobId = context.jobId;
    this.direction = context.direction;
  }
}

// Metric label `reason="key_unknown"`. Raised when the envelope is well-formed but the receiver lacks the static key (e.g. zone not yet enrolled); never raised by the primitive layer.
export class SealKeyUnknownError extends SealOpenError {
  constructor(message = 'sealing key unknown', context: SealErrorContext = {}, options: ErrorOptions = {}) {
    super(message, context, options);
    this.name = 'SealKeyUnknownError';
  }
}
