import { Injectable } from '@nestjs/common';

import { getErrorMessage } from '../common/errors';
import type { HttpProbeResult } from '../contract';

export const PROBE_TIMEOUT_MS = 2_000;
const PROBE_ATTEMPTS = 2;

@Injectable()
export class HttpProbeService {
  // a host saturated by a second stack coming up drops single requests; retry once so one miss
  // isn't reported as an outage.
  async probe(target: string): Promise<HttpProbeResult> {
    let result = await this.attempt(target);
    for (let attempt = 1; attempt < PROBE_ATTEMPTS && !result.ok; attempt += 1) {
      result = await this.attempt(target);
    }
    return result;
  }

  private async attempt(target: string): Promise<HttpProbeResult> {
    const startedAt = Date.now();
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const latencyMs = Date.now() - startedAt;
      if (res.ok) return { target, ok: true, statusCode: res.status, latencyMs, detail: null };
      return { target, ok: false, statusCode: res.status, latencyMs, detail: `non-2xx response: ${res.status}` };
    } catch (error) {
      const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
      const detail = isTimeout ? `timeout after ${PROBE_TIMEOUT_MS}ms` : getErrorMessage(error);
      return { target, ok: false, statusCode: null, latencyMs: null, detail };
    }
  }
}
