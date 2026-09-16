import { Logger } from '@nestjs/common';
import { WS_TOKEN_PROTOCOL } from '@repo/local-lab-contract';
import * as pty from 'node-pty';
import type { IncomingMessage, Server } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import { getErrorMessage } from '@repo/utils';
import { engineRoot } from '../common/engine-root';
import { AuthBackoff } from '../common/lab-auth';
import { capabilityAllowed, type Principal } from '../common/lab-capability';
import { auditOriginColumns, type LabOrigin } from '../common/lab-context';
import { effectiveClientAddress, isLoopbackAddress, resolvePrincipal } from '../common/lab-net';
import { serializeAuditParams } from '../common/redact';
import type { AuditOutcome } from '../db/db';
import type { AuditStore } from '../ledger/audit-store';
import { runBacklog, type RunnerService } from '../runner/runner.service';

const LIBVIRT_URI =
  process.env.LOCAL_BROKKR_LIBVIRT_URI ?? (process.platform === 'darwin' ? 'qemu:///session' : 'qemu:///system');
const NODE_RE = /^[a-zA-Z0-9_-]+$/;

// Dimensions must be positive ints — node-pty's resize() throws on 0/negative/NaN, and an uncaught throw inside ws.on('message') would take down the lab API.
const ControlFrameSchema = z.object({
  i: z.string().optional(),
  r: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});
export type ControlFrame = z.infer<typeof ControlFrameSchema>;

export function readControl(raw: unknown): ControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  const result = ControlFrameSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function onFleetShell(ws: WebSocket, req: IncomingMessage): void {
  const log = new Logger('FleetShell');
  const node = new URL(req.url ?? '', 'http://localhost').searchParams.get('node') ?? '';
  if (!NODE_RE.test(node)) {
    ws.send(`\r\n[shell] invalid node '${node}'\r\n`);
    ws.close();
    return;
  }

  log.log(`console attach: ${node}`);
  let term: pty.IPty;
  try {
    const repoRoot = engineRoot();
    term = pty.spawn('bash', [join(repoRoot, 'scripts', 'vm-console.sh'), node, LIBVIRT_URI], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: repoRoot,
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    const msg = getErrorMessage(e);
    log.error(`spawn failed for ${node}: ${msg}`);
    try {
      ws.send(`\r\n[shell] failed to attach to '${node}': ${msg}\r\n`);
    } catch (error) {
      log.debug(`ws send failed for ${node}: ${(error as Error).message}`);
    }
    ws.close();
    return;
  }

  ws.send(
    `\r\n[attaching ${node} serial console — auto-reattaches across power-cycles; Ctrl-] detaches the VM side]\r\n`,
  );
  term.onData((d) => {
    try {
      ws.send(d);
    } catch (error) {
      log.debug(`console ws send failed for ${node}: ${(error as Error).message}`);
    }
  });
  term.onExit(() => ws.close());

  ws.on('message', (raw) => {
    const msg = readControl(raw);
    if (!msg) return;
    if (typeof msg.i === 'string') term.write(msg.i);
    else if (msg.r) {
      try {
        term.resize(msg.r[0], msg.r[1]);
      } catch (error) {
        log.debug(`term resize failed for ${node}: ${(error as Error).message}`);
      }
    }
  });
  ws.on('close', () => {
    log.log(`console detach: ${node}`);
    try {
      term.kill();
    } catch (error) {
      log.debug(`term kill failed for ${node}: ${(error as Error).message}`);
    }
  });
}

function onTestTerm(ws: WebSocket, req: IncomingMessage, runner: RunnerService): void {
  const log = new Logger('TestTerm');
  const runId = new URL(req.url ?? '', 'http://localhost').searchParams.get('runId') ?? '';
  const run = runner.getRun(runId);
  if (!run) {
    ws.send('\r\n[unknown run]\r\n');
    ws.close();
    return;
  }

  try {
    ws.send(runBacklog(run));
  } catch (error) {
    log.debug(`ws backlog send failed for run ${runId}: ${(error as Error).message}`);
  }
  const sub = run.log$.subscribe({
    next: (c) => {
      try {
        ws.send(c);
      } catch (error) {
        log.debug(`ws send failed for run ${runId}: ${(error as Error).message}`);
      }
    },
    complete: () => {
      try {
        ws.send('\r\n\x1b[90m[run finished]\x1b[0m\r\n');
      } catch (error) {
        log.debug(`ws finish send failed for run ${runId}: ${(error as Error).message}`);
      }
    },
  });

  ws.on('message', (raw) => {
    const msg = readControl(raw);
    if (!msg) return;
    if (typeof msg.i === 'string') runner.writeInput(runId, msg.i);
    else if (Array.isArray(msg.r)) runner.resize(runId, msg.r[0], msg.r[1]);
  });
  ws.on('close', () => sub.unsubscribe());
}

// the token itself is never echoed back: a selected subprotocol is repeated in the response
function selectTokenProtocol(protocols: Set<string>): string | false {
  return protocols.has(WS_TOKEN_PROTOCOL) ? WS_TOKEN_PROTOCOL : false;
}

function subprotocolToken(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (raw === undefined) return undefined;
  const offered = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const marker = offered.indexOf(WS_TOKEN_PROTOCOL);
  return marker === -1 ? undefined : offered[marker + 1];
}

const WS_HANDLERS: Record<string, string> = {
  '/api/fleet/shell': 'WebSocket.fleetShell',
  '/api/tests/term': 'WebSocket.testTerm',
};

const upgradeLog = new Logger('WsUpgrade');

// no AsyncLocalStorage here: an upgrade never enters nest, so the origin comes off the raw socket
function upgradeOrigin(req: IncomingMessage, pathname: string, principal: Principal | null): LabOrigin {
  const peer = req.socket.remoteAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  const address = effectiveClientAddress(peer, forwardedFor);
  return {
    ip: address ?? null,
    loopback: isLoopbackAddress(address),
    tokenAuth: principal !== null,
    principal: principal?.id ?? null,
    method: 'WS',
    path: pathname,
  };
}

/** `WS` rather than an http verb: these rows are not requests, and the safe-method audit skip must
 *  never swallow a console attach. */
function recordUpgrade(
  audit: AuditStore,
  req: IncomingMessage,
  url: URL,
  principal: Principal | null,
  outcome: AuditOutcome,
  reason: string | null,
): void {
  const origin = upgradeOrigin(req, url.pathname, principal);
  try {
    audit.insert({
      ts: Date.now(),
      method: 'WS',
      path: url.pathname,
      handler: WS_HANDLERS[url.pathname] ?? 'WebSocket.unknown',
      outcome,
      status_code: null,
      duration_ms: null,
      run_id: null,
      params: serializeAuditParams(Object.fromEntries(url.searchParams)),
      ...auditOriginColumns(origin),
      error: reason,
    });
  } catch (error) {
    upgradeLog.warn(`upgrade audit write failed for ${url.pathname}: ${getErrorMessage(error)}`);
  }
}

/** Its own instance rather than the guard's: an upgrade never enters LabAuthGuard, which holds its
 *  budget privately. */
const upgradeBackoff = new AuthBackoff();

/** One `upgrade` router over `noServer` instances — multiple `{ server, path }` WebSocketServers don't coexist (the first path mismatch aborts the handshake with 400). */
export function attachWebSockets(server: Server, runner: RunnerService, audit: AuditStore): void {
  const fleetWss = new WebSocketServer({ noServer: true, handleProtocols: selectTokenProtocol });
  const testWss = new WebSocketServer({ noServer: true, handleProtocols: selectTokenProtocol });
  fleetWss.on('connection', (ws, req) => onFleetShell(ws, req));
  testWss.on('connection', (ws, req) => onTestTerm(ws, req, runner));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const provided = subprotocolToken(req.headers['sec-websocket-protocol']);
    const principal = resolvePrincipal(provided);
    const forwardedFor = req.headers['x-forwarded-for'];
    const address = effectiveClientAddress(req.socket.remoteAddress, forwardedFor) ?? 'unknown';
    const record = (outcome: AuditOutcome, reason: string | null) =>
      recordUpgrade(audit, req, url, principal, outcome, reason);
    const cooldown = upgradeBackoff.remainingSeconds(address);
    if (cooldown > 0) {
      record('denied', `too many rejected lab tokens; retry in ${cooldown}s`);
      socket.destroy();
      return;
    }
    // a query-string token lands in every access log on the way here, and a subprotocol does not
    if (url.searchParams.has('token')) {
      record('denied', `send the ws token as the '${WS_TOKEN_PROTOCOL}' subprotocol, not a query parameter`);
      socket.destroy();
      return;
    }
    // both ws surfaces are interactive terminals (vm serial console, host test-run pty) — sharp either way.
    if (!capabilityAllowed('host-exec', principal, req.socket.remoteAddress, forwardedFor)) {
      // only an unrecognised token is a guess: a blank one is not an attempt, and a valid token that
      // merely lacks the ceiling is not guessing either.
      if (principal === null && provided) upgradeBackoff.reject(address);
      record('denied', 'ws terminals require the host-exec capability');
      socket.destroy();
      return;
    }
    const { pathname } = url;
    if (pathname === '/api/fleet/shell') {
      record('ok', null);
      fleetWss.handleUpgrade(req, socket, head, (ws) => fleetWss.emit('connection', ws, req));
    } else if (pathname === '/api/tests/term') {
      record('ok', null);
      testWss.handleUpgrade(req, socket, head, (ws) => testWss.emit('connection', ws, req));
    } else {
      record('denied', 'unknown upgrade path');
      socket.destroy();
    }
  });
}
