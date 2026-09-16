import { Injectable, type NestMiddleware } from '@nestjs/common';

import { extractClientIpFromRequest } from './client-ip';
import { runWithClientIp } from './client-ip.context';

export interface ClientIpRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly ip?: string;
}

type NextFn = (err?: unknown) => void;

@Injectable()
export class ClientIpMiddleware implements NestMiddleware {
  use(req: ClientIpRequest, _res: unknown, next: NextFn): void {
    const clientIp = extractClientIpFromRequest(req.headers, req.ip ?? null);
    runWithClientIp(clientIp, () => next());
  }
}
