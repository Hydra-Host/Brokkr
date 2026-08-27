import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { AuditStore } from '../ledger/audit-store';
import { auditParams } from './audit-row';
import { getErrorMessage } from './errors';
import { isMutationOriginAllowed } from './lab-auth';
import { currentOrigin, originColumns } from './lab-context';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const CONTENT_TYPE_DENIAL = 'mutating requests must use content-type: application/json';
const ORIGIN_DENIAL = 'origin is not allowed to make mutating requests against the lab control API';

const log = new Logger('requireJsonMutation');

function isJsonContentType(value: string): boolean {
  return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

// loopback is trusted without a token, and CORS only hides the response — it never stops the request,
// so refusing non-JSON content types (all a form can send) plus foreign Origins is what blocks CSRF.
export function requireJsonMutation(audit: AuditStore) {
  // denials answer ahead of the nest pipeline, so the audit interceptor never sees them — record them
  // like LabAuthGuard does. A failed write must never change the answer.
  const deny = (req: Request, res: Response, status: number, message: string): void => {
    try {
      audit.insert({
        ts: Date.now(),
        method: req.method,
        path: req.path,
        handler: 'requireJsonMutation',
        outcome: 'denied',
        status_code: status,
        duration_ms: null,
        run_id: null,
        params: auditParams(req),
        ...originColumns(currentOrigin()),
        error: message,
      });
    } catch (error) {
      log.warn(`denial audit write failed for ${req.method} ${req.path}: ${getErrorMessage(error)}`);
    }
    res.status(status).json({ error: message });
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    // absent content-type is allowed (ts-rest omits it on optional-body routes); the Origin check below covers that gap.
    const contentType = req.headers['content-type'];
    if (contentType !== undefined && !isJsonContentType(contentType)) {
      deny(req, res, 415, CONTENT_TYPE_DENIAL);
      return;
    }
    // absent Origin is a non-browser client (curl/cli/tests); a browser always sends it when mutating.
    const origin = req.headers.origin;
    // a dual-stack socket reports an ipv4 peer/address with the ::ffff: prefix; compare on the v4 form
    const local = req.socket.localAddress;
    const localAddress = local?.startsWith('::ffff:') ? local.slice('::ffff:'.length) : local;
    // a valid token stands in for an allowlisted origin: it IS an anti-csrf proof, and it is what makes a
    // LAN operator's own hostname work without an allowlist entry per name. A drive-by page cannot hold it
    // — localStorage is origin-scoped, the vite dev server refuses to serve the bundle to a foreign origin,
    // and sending the header at all forces a preflight our CORS allowlist rejects. Loopback callers present
    // no token (they need none), so the gate below is unchanged for them — which is who it was written for.
    const tokenAuth = currentOrigin()?.tokenAuth === true;
    if (origin !== undefined && !tokenAuth && !isMutationOriginAllowed(origin, localAddress)) {
      deny(req, res, 403, ORIGIN_DENIAL);
      return;
    }
    next();
  };
}
