import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { type AppRoute, isAppRoute } from '@ts-rest/core';
import { TsRestAppRouteMetadataKey } from '@ts-rest/nest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditController } from '../audit/audit.controller';
import { BuildController } from '../build/build.controller';
import { type Capability, type RouteCapability } from '../common/lab-capability';
import { LabAuthGuard } from '../common/lab-auth';
import { LAB_PUBLIC_ROUTE, LAB_ROUTE, type LabRouteOptions } from '../common/lab-route';
import { contract } from '../contract';
import { DatastoreController } from '../datastore/datastore.controller';
import { closeDb } from '../db/db';
import { ApiDocsController } from '../docs/api-docs.controller';
import { AuditStore } from '../ledger/audit-store';
import { FleetController } from '../fleet/fleet.controller';
import { HealthController } from '../health/health.controller';
import { HubController } from '../hub/hub.controller';
import { LayersController } from '../layers/layers.controller';
import { QueuesController } from '../queues/queues.controller';
import { RunCapabilityGuard } from '../runs/run-capability.guard';
import { RunsController } from '../runs/runs.controller';
import { RuntimeController } from '../runtime/runtime.controller';
import { ServicesController } from '../services/services.controller';
import { StacksController } from '../services/stacks.controller';
import { StackController } from '../stack/stack.controller';
import { StatusController } from '../status/status.controller';
import { StorageController } from '../storage/storage.controller';
import { SudoController } from '../sudo/sudo.controller';
import { TestController } from '../test/test.controller';
import { ZonesController } from '../zones/zones.controller';

const CONTROLLERS = [
  ApiDocsController,
  AuditController,
  BuildController,
  DatastoreController,
  FleetController,
  HealthController,
  HubController,
  LayersController,
  QueuesController,
  RunsController,
  RuntimeController,
  ServicesController,
  StackController,
  StacksController,
  StatusController,
  StorageController,
  SudoController,
  TestController,
  ZonesController,
];

const EXPECTED: Record<string, RouteCapability> = {
  buildAgent: 'operate',
  buildIpxe: 'operate',
  buildNetbootGrub: 'operate',
  baremetalPower: 'operate',
  cleanQueue: 'operate',
  discoverMachine: 'operate',
  drainQueue: 'operate',
  healFleet: 'operate',
  nukeBlob: 'operate',
  powerMachine: 'operate',
  previewFleetApplyPlan: 'operate',
  primeBlob: 'operate',
  purgeTestRuns: 'operate',
  removeQueueJob: 'operate',
  resetMachine: 'operate',
  resyncStorage: 'operate',
  retryQueueJob: 'operate',
  startTest: 'operate',
  wipeStorage: 'operate',

  controlDatastore: 'admin',
  controlService: 'admin',
  getConfigTree: 'admin',
  listStacks: 'admin',
  putFleetConfig: 'admin',
  putStackBranches: 'admin',
  putStackConfig: 'admin',
  putZonesConfig: 'admin',
  redeployStack: 'admin',
  reloadService: 'admin',
  startStackRun: 'admin',

  cacheSudo: 'host-exec',
  execMachine: 'host-exec',
  runPgQuery: 'host-exec',

  cancelRun: 'per-run',

  getDbMigrations: 'read',
  getDevPubkey: 'read',
  getDeviceTokenEvents: 'read',
  getDiskLayouts: 'read',
  getFleetApplyPlan: 'read',
  getFleetConfig: 'read',
  getFleetVerify: 'read',
  getFleetBootReadiness: 'read',
  getHost: 'read',
  getInitTasks: 'read',
  getLayerCache: 'read',
  getLayerCatalog: 'read',
  getLayersDefaultUrl: 'read',
  getLayersManifest: 'read',
  getLifecycleJob: 'read',
  getLifecycleJobQueueJobs: 'read',
  getMachineBootTrail: 'read',
  getMachineConsoleLog: 'read',
  getPgColumns: 'read',
  getPgRows: 'read',
  getPlanCatalog: 'read',
  getProcessEnv: 'read',
  getQueueJob: 'read',
  getRedisInfo: 'read',
  getRedisValue: 'read',
  getRestartState: 'read',
  getRun: 'read',
  getStackBranches: 'read',
  getStackConfig: 'read',
  getStackPending: 'read',
  getStackState: 'read',
  getStatus: 'read',
  getStorageState: 'read',
  getSudoStatus: 'read',
  getTestResult: 'read',
  getThanosStatus: 'read',
  getZonesConfig: 'read',
  listAppLinks: 'read',
  listAuditEvents: 'read',
  listDeviceTokens: 'read',
  listHostNics: 'read',
  listLifecycleJobs: 'read',
  listMachines: 'read',
  listPci: 'read',
  listPgTables: 'read',
  listQueueJobs: 'read',
  listQueues: 'read',
  listRuns: 'read',
  listServices: 'read',
  listStackOps: 'read',
  listTestEvents: 'read',
  listTests: 'read',
  listThanosMetrics: 'read',
  listWebhookDeliveries: 'read',
  listZoneRuntimes: 'read',
  postTestEvent: 'read',
  queryThanos: 'read',
  queryThanosRange: 'read',
  scanRedisKeys: 'read',
  seedManifest: 'read',
  verifyStorage: 'read',
};

const TOKEN_OK_BY_DESIGN: Record<string, string> = {
  postTestEvent: 'a test running inside a VM posts its own events back; anything above read would break in-VM reporting',
  verifyStorage: 'a POST that only reads — it compares upstream shas against on-disk cache metadata',
  seedManifest: 'writes catalog rows to the hub database — data, not root',
};

const STREAM_CAPABILITY: Record<string, RouteCapability> = {
  'RunsController.stream': 'per-run',
  'ServicesController.log': 'admin',
  'StackController.datastoreLog': 'admin',
  'StackController.initTaskLog': 'admin',
  'FleetController.processLogs': 'admin',
  'TestController.eventStream': 'operate',
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

const ROUTES = new Map<string, AppRoute>();
for (const [name, route] of Object.entries(contract)) {
  if (isAppRoute(route)) ROUTES.set(name, route);
}

const HANDLERS = new Map<AppRoute, HandlerEntry>();
const ALL_HANDLERS: HandlerEntry[] = [];
for (const controller of CONTROLLERS) {
  for (const method of Object.getOwnPropertyNames(controller.prototype)) {
    if (method === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, method);
    if (typeof descriptor?.value !== 'function') continue;
    const handler: Handler = descriptor.value;
    const entry = { controller, method, handler };
    ALL_HANDLERS.push(entry);
    const meta = reflector.get<TsRestHandlerMetadata | undefined>(TsRestAppRouteMetadataKey, handler);
    if (meta) HANDLERS.set(meta.appRoute, entry);
  }
}

function entryFor(name: string): HandlerEntry | undefined {
  const route = ROUTES.get(name);
  return route ? HANDLERS.get(route) : undefined;
}

function optionsOf(handler: Handler): LabRouteOptions | undefined {
  return reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, handler);
}

function annotationOf(name: string): LabRouteOptions | undefined {
  const entry = entryFor(name);
  return entry === undefined ? undefined : optionsOf(entry.handler);
}

function capabilityOf(name: string): RouteCapability {
  return annotationOf(name)?.capability ?? 'read';
}

function streamHandlers(): HandlerEntry[] {
  return ALL_HANDLERS.filter((entry) => Reflect.getMetadata(SSE_METADATA, entry.handler) !== undefined);
}

function nameOf(entry: HandlerEntry): string {
  return `${entry.controller.name}.${entry.method}`;
}

describe('lab route capability classification', () => {
  it('resolves every contract route to a controller handler', () => {
    expect([...ROUTES].filter(([, route]) => !HANDLERS.has(route)).map(([name]) => name)).toEqual([]);
  });

  it('classifies every contract route, GET included', () => {
    expect([...ROUTES.keys()].filter((name) => !(name in EXPECTED))).toEqual([]);
  });

  it('holds no expectation for a route the contract no longer exposes', () => {
    expect(Object.keys(EXPECTED).filter((name) => !ROUTES.has(name))).toEqual([]);
  });

  it('annotates every route the expectation prices above read', () => {
    const wrong = Object.entries(EXPECTED)
      .filter(([name, capability]) => capabilityOf(name) !== capability)
      .map(([name, capability]) => `${name}: expected ${capability}, got ${capabilityOf(name)}`);
    expect(wrong).toEqual([]);
  });

  it('carries an explicit annotation on everything above read, so a deletion fails here', () => {
    const unannotated = Object.keys(EXPECTED)
      .filter((name) => EXPECTED[name] !== 'read')
      .filter((name) => annotationOf(name)?.capability === undefined);
    expect(unannotated).toEqual([]);
  });

  it('leaves every read route un-annotated, so the default and the expectation cannot drift apart', () => {
    const annotated = Object.keys(EXPECTED)
      .filter((name) => EXPECTED[name] === 'read')
      .filter((name) => annotationOf(name) !== undefined);
    expect(annotated).toEqual([]);
  });

  it('justifies every non-GET route left at read', () => {
    const unjustified = [...ROUTES.keys()]
      .filter((name) => ROUTES.get(name)?.method !== 'GET' && EXPECTED[name] === 'read')
      .filter((name) => !(name in TOKEN_OK_BY_DESIGN));
    expect(unjustified).toEqual([]);
  });

  it('holds no justification for a route that is priced above read', () => {
    expect(Object.keys(TOKEN_OK_BY_DESIGN).filter((name) => EXPECTED[name] !== 'read')).toEqual([]);
  });

  it('gives every justification a non-empty reason', () => {
    expect(Object.entries(TOKEN_OK_BY_DESIGN).filter(([, reason]) => reason.trim() === '')).toEqual([]);
  });

});

describe('stream inventory', () => {
  it('classifies every @Sse handler', () => {
    expect(streamHandlers().map(nameOf).sort()).toEqual(Object.keys(STREAM_CAPABILITY).sort());
  });

  it('annotates every stream with the capability of the operation it reports on', () => {
    const wrong = streamHandlers()
      .filter((entry) => optionsOf(entry.handler)?.capability !== STREAM_CAPABILITY[nameOf(entry)])
      .map(nameOf);
    expect(wrong).toEqual([]);
  });
});

describe('per-run derivation', () => {
  it('backs every per-run route with the guard that reads the run', () => {
    const perRun = ALL_HANDLERS.filter((entry) => optionsOf(entry.handler)?.capability === 'per-run');
    expect(perRun.map(nameOf).sort()).toEqual(['RunsController.cancel', 'RunsController.stream']);
    for (const entry of perRun) {
      expect(Reflect.getMetadata(GUARDS_METADATA, entry.handler)).toContain(RunCapabilityGuard);
    }
  });
});

describe('the authentication exemption', () => {
  it('is carried by exactly one handler in the application', () => {
    const exempt = ALL_HANDLERS.filter(
      (entry) => reflector.get<true | undefined>(LAB_PUBLIC_ROUTE, entry.handler) === true,
    );
    expect(exempt.map(nameOf)).toEqual(['HealthController.health']);
  });

  it('is carried by no contract route', () => {
    const exempt = [...ROUTES.keys()].filter((name) => {
      const entry = entryFor(name);
      return entry !== undefined && reflector.get<true | undefined>(LAB_PUBLIC_ROUTE, entry.handler) === true;
    });
    expect(exempt).toEqual([]);
  });
});

function contextFor(name: string, peer: string, headers: Record<string, string | string[]> = {}) {
  const entry = entryFor(name);
  if (!entry) throw new Error(`no handler resolved for ${name}`);
  const req = { method: 'POST', path: `/api/${name}`, ip: peer, socket: { remoteAddress: peer }, headers, query: {} };
  return new ExecutionContextHost([req], entry.controller, entry.handler);
}

describe.each<[string, Capability]>([
  ['execMachine', 'host-exec'],
  ['runPgQuery', 'host-exec'],
  ['cacheSudo', 'host-exec'],
  ['startStackRun', 'admin'],
  ['listStacks', 'admin'],
  ['powerMachine', 'operate'],
])('LabAuthGuard on %s', (name, capability) => {
  let stateDir: string;
  let guard: LabAuthGuard;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'lab-route-capability-'));
    vi.stubEnv('LOCAL_STATE', stateDir);
    guard = new LabAuthGuard(reflector, new AuditStore());
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
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

  it('admits or forbids the api token by the capability the route asks for', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(name, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    if (capability === 'host-exec') {
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    } else {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  it('admits the host token', () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    expect(guard.canActivate(contextFor(name, '10.0.0.5', { authorization: 'Bearer host-token' }))).toBe(true);
  });
});
