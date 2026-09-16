import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { getErrorMessage } from '@repo/utils';
import type { AuditStore } from '../ledger/audit-store';
import { auditParams } from './audit-row';
import { isMutationOriginAllowed } from './lab-auth';
import { auditOriginColumns, currentOrigin } from './lab-context';

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
        ...auditOriginColumns(currentOrigin()),
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
    // a valid token is itself an anti-csrf proof a drive-by page cannot hold, so it stands in for an
    // allowlist entry per hostname. Loopback callers present none and the gate below is unchanged for them.
    const tokenAuth = currentOrigin()?.tokenAuth === true;
    if (origin !== undefined && !tokenAuth && !isMutationOriginAllowed(origin, localAddress)) {
      deny(req, res, 403, ORIGIN_DENIAL);
      return;
    }
    next();
  };
}
