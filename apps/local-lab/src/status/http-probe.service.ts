import { Injectable } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import type { HttpProbeResult } from '../contract';

export const PROBE_TIMEOUT_MS = 2_000;
const PROBE_ATTEMPTS = 2;

export type HttpJsonRead =
  | { ok: true; statusCode: number; body: unknown }
  | { ok: false; statusCode: number | null; detail: string };

const failureDetail = (error: unknown): string => {
  const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
  return isTimeout ? `timeout after ${PROBE_TIMEOUT_MS}ms` : getErrorMessage(error);
};

@Injectable()
export class HttpProbeService {
  async probe(target: string): Promise<HttpProbeResult> {
    return this.retryUntilOk(() => this.attempt(target));
  }

  /** The parsed body of a 2xx answer, under the same timeout and retry as `probe`. */
  async readJson(target: string): Promise<HttpJsonRead> {
    return this.retryUntilOk(() => this.attemptJson(target));
  }

  // a host saturated by a second stack coming up drops single requests; retry once so one miss
  // isn't reported as an outage.
  private async retryUntilOk<T extends { ok: boolean }>(attempt: () => Promise<T>): Promise<T> {
    let result = await attempt();
    for (let n = 1; n < PROBE_ATTEMPTS && !result.ok; n += 1) {
      result = await attempt();
    }
    return result;
  }

  // one fetch-with-timeout primitive; each read shape maps the response and the failure detail onto its own result
  private async guarded<T>(
    target: string,
    onResponse: (res: Response) => Promise<T>,
    onFailure: (detail: string) => T,
  ): Promise<T> {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return await onResponse(res);
    } catch (error) {
      return onFailure(failureDetail(error));
    }
  }

  private attempt(target: string): Promise<HttpProbeResult> {
    const startedAt = Date.now();
    return this.guarded<HttpProbeResult>(
      target,
      async (res) => {
        const latencyMs = Date.now() - startedAt;
        if (res.ok) return { target, ok: true, statusCode: res.status, latencyMs, detail: null };
        return { target, ok: false, statusCode: res.status, latencyMs, detail: `non-2xx response: ${res.status}` };
      },
      (detail) => ({ target, ok: false, statusCode: null, latencyMs: null, detail }),
    );
  }

  private attemptJson(target: string): Promise<HttpJsonRead> {
    return this.guarded<HttpJsonRead>(
      target,
      async (res) => {
        if (!res.ok) return { ok: false, statusCode: res.status, detail: `non-2xx response: ${res.status}` };
        return { ok: true, statusCode: res.status, body: await res.json() };
      },
      (detail) => ({ ok: false, statusCode: null, detail }),
    );
  }
}
