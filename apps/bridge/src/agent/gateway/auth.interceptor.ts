import type { AuthSubject } from '../../auth/agent-token.service';

const BEARER_PREFIX = 'bearer ';

const REJECT_MESSAGE = 'invalid or missing agent token';

export type GrpcMetadata = Iterable<readonly [string, unknown]> | null | undefined;

export function extractBearer(metadata: GrpcMetadata): string | null {
  if (metadata == null) return null;
  for (const [key, value] of metadata) {
    if (typeof key !== 'string') continue;
    if (key.toLowerCase() !== 'authorization') continue;
    if (typeof value !== 'string') continue;
    if (value.toLowerCase().startsWith(BEARER_PREFIX)) {
      return value.slice(BEARER_PREFIX.length).trim();
    }
  }
  return null;
}

export interface TokenVerifierPort {
  verify(token: string, jobId?: string): Promise<AuthSubject | null>;
}

export interface AuthContextBinder {
  bind<T>(subject: AuthSubject, fn: () => Promise<T>): Promise<T>;
}

export interface AuthInterceptorLogger {
  warning(msg: string): void | Promise<void>;
}

export interface InterceptableCall {
  readonly method: string;
  readonly metadata: GrpcMetadata;
  /** abort() MUST throw or reject so the downstream handler is unreachable. */
  abort(code: GrpcStatusCode, message: string): Promise<never>;
}

export enum GrpcStatusCode {
  UNAUTHENTICATED = 16,
}

/** Streaming RPCs: the bootstrap MUST wrap the server-stream generator so the bind covers every yield — see gateway.module.ts. */
export class DeviceAuthInterceptor {
  constructor(
    private readonly tokenService: TokenVerifierPort,
    private readonly binder: AuthContextBinder,
    private readonly logger: AuthInterceptorLogger,
  ) {}

  async intercept<T>(call: InterceptableCall, next: () => Promise<T>): Promise<T> {
    const raw = extractBearer(call.metadata);
    const subject = raw === null ? null : await this.tokenService.verify(raw);
    if (subject === null) {
      const reason = raw === null ? 'missing' : 'invalid';
      await this.logger.warning(`auth rejected method=${call.method} reason=${reason}`);
      await call.abort(GrpcStatusCode.UNAUTHENTICATED, REJECT_MESSAGE);
      throw new Error('unreachable: call.abort must throw');
    }
    return this.binder.bind(subject, next);
  }
}
