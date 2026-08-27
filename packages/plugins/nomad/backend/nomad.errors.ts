/** Structured Nomad HTTP 4xx/5xx error (prefer over raw fetch/undici failures). */
export class NomadHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;
  readonly method: string;

  constructor(args: { method: string; path: string; status: number; body: unknown; message?: string }) {
    const summary =
      typeof args.body === 'string' && args.body.length > 0
        ? args.body
        : typeof args.body === 'object' && args.body !== null && 'message' in args.body
          ? String((args.body as { message: unknown }).message)
          : `HTTP ${args.status}`;
    super(args.message ?? `Nomad ${args.method} ${args.path} failed: ${summary}`);
    this.name = 'NomadHttpError';
    this.status = args.status;
    this.body = args.body;
    this.path = args.path;
    this.method = args.method;
  }
}
