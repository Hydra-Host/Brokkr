import { Logger } from '@nestjs/common';
import * as pty from 'node-pty';
import type { IncomingMessage, Server } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';

import { engineRoot } from '../common/engine-root';
import { getErrorMessage } from '../common/errors';
import { type LabOrigin, originColumns } from '../common/lab-context';
import { exposureAllowed } from '../common/lab-exposure';
import {
  effectiveClientAddress,
  extractToken,
  isConnectionAuthorized,
  isLoopbackAddress,
  tokenMatches,
} from '../common/lab-net';
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

const WS_HANDLERS: Record<string, string> = {
  '/api/fleet/shell': 'WebSocket.fleetShell',
  '/api/tests/term': 'WebSocket.testTerm',
};

const upgradeLog = new Logger('WsUpgrade');

// no AsyncLocalStorage here: an upgrade never enters nest, so the origin comes off the raw socket
function upgradeOrigin(req: IncomingMessage, pathname: string, tokenAuth: boolean): LabOrigin {
  const peer = req.socket.remoteAddress;
  const forwardedFor = req.headers['x-forwarded-for'];
  const address = effectiveClientAddress(peer, forwardedFor);
  return {
    ip: address ?? null,
    loopback: isLoopbackAddress(address),
    tokenAuth,
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
  tokenAuth: boolean,
  outcome: AuditOutcome,
  reason: string | null,
): void {
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
      ...originColumns(upgradeOrigin(req, url.pathname, tokenAuth)),
      error: reason,
    });
  } catch (error) {
    upgradeLog.warn(`upgrade audit write failed for ${url.pathname}: ${getErrorMessage(error)}`);
  }
}

/** One `upgrade` router over `noServer` instances — multiple `{ server, path }` WebSocketServers don't coexist (the first path mismatch aborts the handshake with 400). */
export function attachWebSockets(server: Server, runner: RunnerService, audit: AuditStore): void {
  const fleetWss = new WebSocketServer({ noServer: true });
  const testWss = new WebSocketServer({ noServer: true });
  fleetWss.on('connection', (ws, req) => onFleetShell(ws, req));
  testWss.on('connection', (ws, req) => onTestTerm(ws, req, runner));

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = extractToken(req.headers.authorization, req.headers['x-lab-token'], url.searchParams.get('token'));
    const record = (outcome: AuditOutcome, reason: string | null) =>
      recordUpgrade(audit, req, url, tokenMatches(token), outcome, reason);
    if (!isConnectionAuthorized(req.socket.remoteAddress, token, req.headers['x-forwarded-for'])) {
      record('denied', 'no valid LAB_API_TOKEN for a non-loopback upgrade');
      socket.destroy();
      return;
    }
    // both ws surfaces are interactive terminals (vm serial console, host test-run pty) — sharp either way.
    if (!exposureAllowed('loopback-only', req.socket.remoteAddress, req.headers['x-forwarded-for'])) {
      record('denied', 'ws terminals are loopback-only');
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
