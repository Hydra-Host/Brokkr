// the ts-rest react-query client throws non-2xx responses as the response object ({ status, body })
// and network failures as an Error; extract a message from either shape by narrowing, never casting.

export function bodyError(body: unknown): string | undefined {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body;
    if (typeof error === 'string') return error;
  }
  return undefined;
}

export function thrownBodyError(thrown: unknown): string | undefined {
  if (typeof thrown === 'object' && thrown !== null && 'body' in thrown) return bodyError(thrown.body);
  return undefined;
}

export function isClientErrorResponse(thrown: unknown): boolean {
  if (typeof thrown !== 'object' || thrown === null || !('status' in thrown)) return false;
  const { status } = thrown;
  return typeof status === 'number' && status >= 400 && status < 500;
}

export function responseStatus(thrown: unknown): number | undefined {
  if (typeof thrown === 'object' && thrown !== null && 'status' in thrown) {
    const { status } = thrown;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

export function thrownBody(thrown: unknown): unknown {
  if (typeof thrown === 'object' && thrown !== null && 'body' in thrown) return thrown.body;
  return undefined;
}

export function activeJobsFromBody(body: unknown): number {
  if (body !== null && typeof body === 'object' && 'activeJobs' in body && typeof body.activeJobs === 'number') {
    return body.activeJobs;
  }
  return 0;
}

export function errorMessage(thrown: unknown): string | null {
  if (!thrown) return null;
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === 'object') {
    if ('body' in thrown) {
      const msg = bodyError(thrown.body);
      // an explicit empty-string body.error suppresses the banner; fall to status only when absent.
      if (msg !== undefined) return msg;
    }
    if ('status' in thrown) {
      const { status } = thrown;
      if (typeof status === 'number') return `request failed (${status})`;
    }
  }
  return String(thrown);
}
