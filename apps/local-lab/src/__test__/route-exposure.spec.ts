import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { type AppRoute, isAppRoute } from '@ts-rest/core';
import { TsRestAppRouteMetadataKey } from '@ts-rest/nest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuildController } from '../build/build.controller';
import { LabAuthGuard } from '../common/lab-auth';
import { type LabExposure } from '../common/lab-exposure';
import { LAB_ROUTE, type LabRouteOptions } from '../common/lab-route';
import { contract } from '../contract';
import { DatastoreController } from '../datastore/datastore.controller';
import { closeDb } from '../db/db';
import { AuditStore } from '../ledger/audit-store';
import { FleetController } from '../fleet/fleet.controller';
import { LayersController } from '../layers/layers.controller';
import { QueuesController } from '../queues/queues.controller';
import { RunsController } from '../runs/runs.controller';
import { ServicesController } from '../services/services.controller';
import { StackController } from '../stack/stack.controller';
import { StatusController } from '../status/status.controller';
import { StorageController } from '../storage/storage.controller';
import { SudoController } from '../sudo/sudo.controller';
import { TestController } from '../test/test.controller';
import { ZonesController } from '../zones/zones.controller';

const CONTROLLERS = [
  BuildController,
  DatastoreController,
  FleetController,
  LayersController,
  QueuesController,
  RunsController,
  ServicesController,
  StackController,
  StatusController,
  StorageController,
  SudoController,
  TestController,
  ZonesController,
];

const TOKEN_OK_BY_DESIGN: Record<string, string> = {
  postTestEvent: 'a test running inside a VM posts its own events back; loopback-only would break in-VM reporting',
  verifyStorage: 'a POST that only reads — it compares upstream shas against on-disk cache metadata',
  cancelRun: 'de-escalation: SIGTERM to a run the caller can already see, never an escalation',
  seedManifest: 'writes catalog rows to the hub database — data, not root',
};

type Handler = (...args: unknown[]) => unknown;

interface TsRestHandlerMetadata {
  appRoute: AppRoute;
  routeKey: string | null;
}

interface HandlerEntry {
  controller: (typeof CONTROLLERS)[number];
  method: string;
  handler: Handler;
}

const reflector = new Reflector();

const NON_GET_ROUTES = new Map<string, AppRoute>();
for (const [name, route] of Object.entries(contract)) {
  if (isAppRoute(route) && route.method !== 'GET') NON_GET_ROUTES.set(name, route);
}

const HANDLERS = new Map<AppRoute, HandlerEntry>();
for (const controller of CONTROLLERS) {
  for (const method of Object.getOwnPropertyNames(controller.prototype)) {
    if (method === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, method);
    if (typeof descriptor?.value !== 'function') continue;
    const handler: Handler = descriptor.value;
    const meta = reflector.get<TsRestHandlerMetadata | undefined>(TsRestAppRouteMetadataKey, handler);
    if (meta) HANDLERS.set(meta.appRoute, { controller, method, handler });
  }
}

function entryFor(name: string): HandlerEntry | undefined {
  const route = NON_GET_ROUTES.get(name);
  return route ? HANDLERS.get(route) : undefined;
}

function exposureOf(name: string): LabExposure | undefined {
  const entry = entryFor(name);
  return entry ? reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, entry.handler)?.exposure : undefined;
}

describe('non-GET lab route exposure classification', () => {
  it('resolves every non-GET contract route to a controller handler', () => {
    expect([...NON_GET_ROUTES].filter(([, route]) => !HANDLERS.has(route)).map(([name]) => name)).toEqual([]);
  });

  it('marks every non-GET route loopback-only unless TOKEN_OK_BY_DESIGN justifies it', () => {
    const unclassified = [...NON_GET_ROUTES.keys()].filter(
      (name) => exposureOf(name) !== 'loopback-only' && !(name in TOKEN_OK_BY_DESIGN),
    );
    expect(unclassified).toEqual([]);
  });

  it('never justifies a route that is also annotated loopback-only', () => {
    expect(Object.keys(TOKEN_OK_BY_DESIGN).filter((name) => exposureOf(name) === 'loopback-only')).toEqual([]);
  });

  it('holds no justification for a route the contract no longer exposes as non-GET', () => {
    expect(Object.keys(TOKEN_OK_BY_DESIGN).filter((name) => !NON_GET_ROUTES.has(name))).toEqual([]);
  });

  it('gives every justification a non-empty reason', () => {
    expect(Object.entries(TOKEN_OK_BY_DESIGN).filter(([, reason]) => reason.trim() === '')).toEqual([]);
  });

  it('documents the restriction in the description of every loopback-only route', () => {
    const undocumented = [...NON_GET_ROUTES]
      .filter(([name, route]) => exposureOf(name) === 'loopback-only' && !/loopback-only/i.test(route.description ?? ''))
      .map(([name]) => name);
    expect(undocumented).toEqual([]);
  });

  it('never claims a loopback-only restriction in the description of a token-ok route', () => {
    const overclaimed = [...NON_GET_ROUTES]
      .filter(([name, route]) => exposureOf(name) !== 'loopback-only' && /loopback-only/i.test(route.description ?? ''))
      .map(([name]) => name);
    expect(overclaimed).toEqual([]);
  });

  it('keeps postTestEvent token-ok so a test running inside a VM can report its own events', () => {
    expect(exposureOf('postTestEvent')).toBeUndefined();
    expect(TOKEN_OK_BY_DESIGN).toHaveProperty('postTestEvent');
  });
});

function contextFor(name: string, peer: string, headers: Record<string, string | string[]> = {}) {
  const entry = entryFor(name);
  if (!entry) throw new Error(`no handler resolved for ${name}`);
  const req = { method: 'POST', path: `/api/${name}`, ip: peer, socket: { remoteAddress: peer }, headers, query: {} };
  return new ExecutionContextHost([req], entry.controller, entry.handler);
}

describe.each(['execMachine', 'runPgQuery', 'cacheSudo', 'startStackRun'])('LabAuthGuard on %s', (name) => {
  let stateDir: string;
  let guard: LabAuthGuard;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'lab-route-exposure-'));
    vi.stubEnv('LOCAL_STATE', stateDir);
    guard = new LabAuthGuard(reflector, new AuditStore());
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('forbids a remote peer presenting a valid token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(name, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows a loopback peer', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    expect(guard.canActivate(contextFor(name, '127.0.0.1'))).toBe(true);
  });

  it('rejects a remote peer with no token as unauthorized, not forbidden', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(name, '10.0.0.5');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).not.toThrow(ForbiddenException);
  });
});
