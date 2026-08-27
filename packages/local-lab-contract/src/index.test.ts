import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { CcBuildSchema } from './schemas/common';
import {
  DiskSpecSchema,
  FleetConfigSchema,
  FleetNetworkSchema,
  FleetNodeEffectiveSchema,
  FleetNodeSchema,
  FleetPendingSchema,
  FleetTombstoneSchema,
  FleetVerifyReportSchema,
  HostInfoSchema,
  LayersManifestSchema,
} from './schemas/fleet';
import { BranchCheckoutResultSchema, StackConfigSchema, StackSlotSchema } from './schemas/stack';
import { StatusSchema } from './schemas/status';
import { PlanJsonSchema, PostTestEventSchema, ResultStatusSchema, TestResultSchema } from './schemas/test';

const EXPECTED_ROUTES = [
  'getStatus',
  'listRuns',
  'getRun',
  'cancelRun',
  'listStackOps',
  'startStackRun',
  'getStackState',
  'getRestartState',
  'getInitTasks',
  'controlDatastore',
  'listServices',
  'listAppLinks',
  'controlService',
  'reloadService',
  'getProcessEnv',
  'getStackConfig',
  'getConfigTree',
  'putStackConfig',
  'redeployStack',
  'getStackBranches',
  'putStackBranches',
  'listStacks',
  'getSudoStatus',
  'cacheSudo',
  'listTests',
  'startTest',
  'getDiskLayouts',
  'getLayerCatalog',
  'getPlanCatalog',
  'purgeTestRuns',
  'getTestResult',
  'postTestEvent',
  'listTestEvents',
  'listMachines',
  'powerMachine',
  'discoverMachine',
  'resetMachine',
  'execMachine',
  'getMachineConsoleLog',
  'baremetalPower',
  'getHost',
  'listHostNics',
  'listPci',
  'getFleetConfig',
  'getFleetApplyPlan',
  'getStackPending',
  'getZonesConfig',
  'putZonesConfig',
  'previewFleetApplyPlan',
  'getFleetVerify',
  'healFleet',
  'getDevPubkey',
  'putFleetConfig',
  'seedManifest',
  'getLayerCache',
  'getLayersDefaultUrl',
  'primeBlob',
  'nukeBlob',
  'getLayersManifest',
  'buildAgent',
  'buildNetbootGrub',
  'buildIpxe',
  'listPgTables',
  'getPgColumns',
  'getPgRows',
  'runPgQuery',
  'getDbMigrations',
  'getRedisInfo',
  'scanRedisKeys',
  'getRedisValue',
  'getThanosStatus',
  'listThanosMetrics',
  'queryThanos',
  'queryThanosRange',
  'listQueues',
  'listQueueJobs',
  'getQueueJob',
  'listWebhookDeliveries',
  'listLifecycleJobs',
  'getLifecycleJob',
  'getLifecycleJobQueueJobs',
  'listDeviceTokens',
  'getDeviceTokenEvents',
  'retryQueueJob',
  'removeQueueJob',
  'drainQueue',
  'cleanQueue',
  'listZoneRuntimes',
  'getStorageState',
  'wipeStorage',
  'resyncStorage',
  'verifyStorage',
  'listAuditEvents',
];

describe('local-lab contract', () => {
  it('exposes exactly the expected flat route set', () => {
    expect(Object.keys(contract).sort()).toEqual([...EXPECTED_ROUTES].sort());
  });

  it('every route has a summary and a description', () => {
    for (const [name, route] of Object.entries(contract)) {
      if (!isAppRoute(route)) continue;
      expect(route.summary, `${name} is missing a summary`).toBeTruthy();
      expect(route.description, `${name} is missing a description`).toBeTruthy();
    }
  });

  it('parses the getProcessEnv reveal query param as a string boolean', () => {
    const route = contract.getProcessEnv;
    if (!isAppRoute(route) || !route.query) throw new Error('getProcessEnv route/query missing');
    expect(route.query.parse({ reveal: 'false' })).toEqual({ reveal: false });
    expect(route.query.parse({ reveal: 'true' })).toEqual({ reveal: true });
    expect(route.query.parse({})).toEqual({ reveal: undefined });
    expect(() => route.query.parse({ reveal: '1' })).toThrow();
    expect(() => route.query.parse({ reveal: 'yes' })).toThrow();
  });

  it('startStackRun accepts an optional force flag (defaulting to false)', () => {
    const route = contract.startStackRun;
    if (!isAppRoute(route) || !route.body) throw new Error('startStackRun body missing');
    expect(route.body.parse({ opId: 'fleet-mode-apply' })).toMatchObject({ force: false });
    expect(route.body.parse({ opId: 'fleet-mode-apply', force: true })).toMatchObject({ force: true });
  });

  it('startStackRun 409 carries an optional activeJobs count', () => {
    const route = contract.startStackRun;
    if (!isAppRoute(route)) throw new Error('startStackRun not a route');
    const body409 = route.responses[409];
    expect(body409.parse({ error: 'busy', activeJobs: 4 })).toMatchObject({ activeJobs: 4 });
    expect(body409.parse({ error: 'busy' })).toEqual({ error: 'busy' });
  });

  it('putStackConfig 200 parses applied/rejected arrays and rejects a body missing them', () => {
    const route = contract.putStackConfig;
    if (!isAppRoute(route)) throw new Error('putStackConfig not a route');
    expect(route.responses[200].parse({ ok: true, applied: [], rejected: [] })).toEqual({
      ok: true,
      applied: [],
      rejected: [],
    });
    expect(() => route.responses[200].parse({ ok: true })).toThrow();
  });

  it('putFleetConfig 200 parses the rejected array and rejects a body missing it', () => {
    const route = contract.putFleetConfig;
    if (!isAppRoute(route)) throw new Error('putFleetConfig not a route');
    expect(route.responses[200].parse({ ok: true, rejected: [] })).toEqual({ ok: true, rejected: [] });
    expect(
      route.responses[200].parse({
        ok: true,
        rejected: [{ path: 'fleet.mode', reason: 'pinned', detail: 'FLEET_MODE' }],
      }),
    ).toMatchObject({ rejected: [{ path: 'fleet.mode', reason: 'pinned' }] });
    expect(() => route.responses[200].parse({ ok: true })).toThrow();
  });

  it('redeployStack 200 returns a runId, not an ok flag', () => {
    const route = contract.redeployStack;
    if (!isAppRoute(route)) throw new Error('redeployStack not a route');
    expect(route.responses[200].parse({ runId: 'x' })).toEqual({ runId: 'x' });
    expect(() => route.responses[200].parse({ ok: true })).toThrow();
  });

  it('reloadService 200 returns a runId, not an ok flag', () => {
    const route = contract.reloadService;
    if (!isAppRoute(route)) throw new Error('reloadService not a route');
    expect(route.responses[200].parse({ runId: 'x' })).toEqual({ runId: 'x' });
    expect(() => route.responses[200].parse({ ok: true })).toThrow();
  });

  it('controlService has no 404 response', () => {
    const route = contract.controlService;
    if (!isAppRoute(route)) throw new Error('controlService not a route');
    expect(route.responses[404]).toBeUndefined();
  });

  it('powerMachine, discoverMachine, and resetMachine declare a 409 in-flight response', () => {
    for (const name of ['powerMachine', 'discoverMachine', 'resetMachine'] as const) {
      const route = contract[name];
      if (!isAppRoute(route)) throw new Error(`${name} not a route`);
      expect(route.responses[409], `${name} missing 409`).toBeDefined();
      expect(route.responses[409].parse({ error: 'fleet busy' })).toEqual({ error: 'fleet busy' });
    }
  });

  it('cacheSudo declares a 429 alongside the 401 rejection', () => {
    const route = contract.cacheSudo;
    if (!isAppRoute(route)) throw new Error('cacheSudo not a route');
    expect(route.responses[401]).toBeDefined();
    expect(route.responses[429]).toBeDefined();
    expect(route.responses[429].parse({ error: 'retry in 30s' })).toEqual({ error: 'retry in 30s' });
  });

  it('putStackBranches body accepts valid branch names', () => {
    const route = contract.putStackBranches;
    if (!isAppRoute(route) || !route.body) throw new Error('putStackBranches body missing');
    expect(route.body.parse({ branch: 'feat/x' })).toEqual({ branch: 'feat/x' });
    expect(route.body.parse({ branch: 'release-1.2' })).toEqual({ branch: 'release-1.2' });
    expect(route.body.parse({ branch: 'wip-' })).toEqual({ branch: 'wip-' });
  });

  it('putStackBranches body rejects unsafe branch names', () => {
    const route = contract.putStackBranches;
    if (!isAppRoute(route) || !route.body) throw new Error('putStackBranches body missing');
    for (const branch of ['-x', 'a..b', 'a b', '', '--force', ' x ', 'x.', 'x/']) {
      expect(() => route.body.parse({ branch })).toThrow();
    }
  });

  it('getStackBranches 200 parses a flat RepoBranch and rejects the old hub/spoke wrapper', () => {
    const route = contract.getStackBranches;
    if (!isAppRoute(route)) throw new Error('getStackBranches not a route');
    expect(route.responses[200].parse({ branch: 'main', error: null })).toEqual({ branch: 'main', error: null });
    expect(() =>
      route.responses[200].parse({ hub: { branch: 'main', error: null }, spoke: { branch: 'main', error: null } }),
    ).toThrow();
  });

  it('BranchCheckoutResultSchema requires ccRebuildRequired alongside the flat RepoBranch shape', () => {
    const ok = { branch: 'main', error: null, ccRebuildRequired: true };
    expect(BranchCheckoutResultSchema.parse(ok)).toEqual(ok);
    expect(() => BranchCheckoutResultSchema.parse({ branch: 'main', error: null })).toThrow();
  });

  it('CcBuildSchema carries the stamp, the live head, and the skew flag', () => {
    const unknown = { sha: null, builtAt: null, headSha: null, stale: false };
    expect(CcBuildSchema.parse(unknown)).toEqual(unknown);
    const full = { sha: 'a'.repeat(40), builtAt: 1_700_000_000_000, headSha: 'b'.repeat(40), stale: true };
    expect(CcBuildSchema.parse(full)).toEqual(full);
  });

  it('StatusSchema app carries ccBuild', () => {
    const app = {
      pid: 1,
      startedAt: 1,
      uptimeSec: 1,
      memlockLimit: 'unlimited',
      distBuiltAt: null,
      stale: false,
      ccBuild: { sha: null, builtAt: null, headSha: null, stale: false },
    };
    expect(StatusSchema.shape.app.parse(app).ccBuild.stale).toBe(false);
  });

  it('StatusSchema carries the composed fleet bring-up state', () => {
    const fleetHealth = {
      health: 'coming-up',
      phase: 'init',
      step: 'build-ipxe',
      label: 'building per-VM iPXE binary for cpu-3',
      node: 'cpu-3',
      index: 3,
      total: 4,
      stepOrdinal: 4,
      stepCount: 9,
      elapsedSec: 72,
      machinesExpected: 4,
      machinesRunning: 0,
      accel: 'tcg',
      accelForced: false,
      detail: 'building per-VM iPXE binary for cpu-3',
    };

    expect(StatusSchema.shape.fleetHealth.parse(fleetHealth)).toEqual(fleetHealth);
    expect(StatusSchema.shape.fleetHealth.parse(undefined)).toBeUndefined();
  });

  it('HostInfoSchema requires the ccBuild stamp block', () => {
    const base = { os: 'linux', arch: 'amd64', passthroughSupported: true, lanIp: '192.168.1.2' };
    const ccBuild = { sha: null, builtAt: null, headSha: null, stale: false };
    expect(HostInfoSchema.parse({ ...base, ccBuild }).ccBuild).toEqual(ccBuild);
    const full = { sha: 'a'.repeat(40), builtAt: 1_700_000_000_000, headSha: 'b'.repeat(40), stale: true };
    expect(HostInfoSchema.parse({ ...base, ccBuild: full }).ccBuild).toEqual(full);
    expect(() => HostInfoSchema.parse(base)).toThrow();
  });

  it('FleetPending severity accepts mode-change', () => {
    const base = {
      inSync: false,
      severity: 'mode-change' as const,
      desiredDigest: 'sha256:x',
      appliedDigest: 'sha256:y',
      appliedAt: 1,
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
      nodes: { added: [], removed: [], changed: [] },
      network: { changed: false, fields: [] },
      note: null,
    };
    expect(FleetPendingSchema.parse(base).severity).toBe('mode-change');
    expect(() => FleetPendingSchema.parse({ ...base, severity: 'nonsense' })).toThrow();
  });

  it('LayersManifestSchema accepts a realistic sample and retains unknown keys via passthrough', () => {
    const sample = {
      version: '2026.01.0',
      env: 'dev',
      schema_version: 3,
      pipeline_id: 42,
      generated_at: '2026-01-02T03:04:05Z',
      future_top_level_field: { anything: true },
      groups: [{ slug: 'gpuDriver', name: 'GPU Driver', selection_type: 'SINGLE_SELECT', future_group_field: 1 }],
      layers: [
        {
          name: 'nvidia-570',
          kind: 'component',
          group: 'gpuDriver',
          arch: 'amd64',
          sha256: 'f'.repeat(64),
          size: 123,
          requires: [{ group: 'gpuFramework', layers: ['cuda-12'], future_req_field: 'x' }],
          future_layer_field: 'kept',
        },
      ],
    };
    const parsed = LayersManifestSchema.parse(sample);
    expect(parsed.groups[0]?.slug).toBe('gpuDriver');
    expect(parsed.layers[0]?.name).toBe('nvidia-570');
    expect(parsed).toHaveProperty('future_top_level_field', { anything: true });
  });

  it('LayersManifestSchema accepts the nulls a published manifest actually carries', () => {
    const sample = {
      version: '1.2.1',
      env: 'prod',
      groups: [{ slug: 'gpuDriver', name: 'GPU Driver', selection_type: 'SINGLE_SELECT' }],
      layers: [
        {
          name: 'nvidia-570',
          kind: 'component',
          group: 'gpuDriver',
          arch: 'amd64',
          version: null,
          variant: null,
          source_version: null,
          kernel: null,
          release_version: null,
        },
      ],
    };
    const parsed = LayersManifestSchema.parse(sample);
    expect(parsed.layers[0]?.source_version).toBeNull();
    expect(parsed.layers[0]).toHaveProperty('kernel', null);
  });

  it('LayersManifestSchema rejects a non-array layers field', () => {
    expect(() => LayersManifestSchema.parse({ groups: [], layers: 'nope' })).toThrow();
  });

  it('getLayersManifest 200 requires resolvedUrl and doc', () => {
    const route = contract.getLayersManifest;
    if (!isAppRoute(route)) throw new Error('getLayersManifest not a route');
    const body = { resolvedUrl: 'https://assets.example.com/os-layers/releases/v1', doc: { groups: [], layers: [] } };
    expect(route.responses[200].parse(body)).toMatchObject({ resolvedUrl: body.resolvedUrl });
    expect(() => route.responses[200].parse({ doc: { groups: [], layers: [] } })).toThrow();
    expect(() => route.responses[200].parse({ resolvedUrl: body.resolvedUrl })).toThrow();
  });

  it('seedManifest declares a 400 error response', () => {
    const route = contract.seedManifest;
    if (!isAppRoute(route)) throw new Error('seedManifest not a route');
    expect(route.responses[400]).toBeDefined();
    expect(route.responses[400].parse({ error: 'nope' })).toEqual({ error: 'nope' });
  });

  it('retains unknown nested keys on a group and a layer via passthrough', () => {
    const parsed = LayersManifestSchema.parse({
      groups: [{ slug: 'g', name: 'G', selection_type: 'SINGLE_SELECT', extra_group_key: 'kept' }],
      layers: [
        {
          name: 'l',
          kind: 'component',
          group: 'g',
          arch: 'amd64',
          requires: [{ group: 'g2', layers: ['x'], extra_req_key: 'kept' }],
          extra_layer_key: 'kept',
        },
      ],
    });
    expect(parsed.groups[0]).toHaveProperty('extra_group_key', 'kept');
    expect(parsed.layers[0]).toHaveProperty('extra_layer_key', 'kept');
    expect(parsed.layers[0]?.requires?.[0]).toHaveProperty('extra_req_key', 'kept');
  });

  it('DiskSpecSchema accepts partial specs (engine defaults size/type)', () => {
    expect(DiskSpecSchema.parse({ size_gb: 500 })).toEqual({ size_gb: 500 });
    expect(DiskSpecSchema.parse({})).toEqual({});
    expect(DiskSpecSchema.parse({ size_gb: 100, type: 'nvme' })).toEqual({ size_gb: 100, type: 'nvme' });
    expect(() => DiskSpecSchema.parse({ size_gb: -1 })).toThrow();
    expect(() => DiskSpecSchema.parse({ type: 'floppy' })).toThrow();
  });

  const fleetNode = (over: Record<string, unknown> = {}) => ({
    name: 'gpu-1',
    zone: 'sim-zone',
    ipmi_mac: 'aa:bb:cc:00:00:01',
    data_mac: 'aa:bb:cc:00:00:02',
    cpus: 2,
    memory_mb: 4096,
    disk_gb: 40,
    arch: null,
    disks: [],
    passthrough: [],
    nics: [],
    data_mtu: null,
    network_type: null,
    ip: null,
    bmc_ip: null,
    bmc: null,
    effective_cpus: 2,
    effective_memory_mb: 4096,
    effective_disk_gb: 40,
    ...over,
  });

  const fleetNetwork = (over: Record<string, unknown> = {}) => ({
    name: 'brokkr-net',
    cidr: '192.168.200.0/24',
    bmcCidr: '192.168.105.0/24',
    domain: 'sim.local',
    dhcp: false,
    renderedNetplan: false,
    ...over,
  });

  const fleetConfig = (nodes: ReturnType<typeof fleetNode>[]) => ({
    source: 'default',
    mode: 'vm',
    baremetal: { nics: [], arch: 'amd64', nodes: [] },
    bakedChainUrl: null,
    nodes,
    zones: [],
    network: fleetNetwork(),
    tombstones: [],
    bmcDefaults: { username: 'admin', password: 'admin' },
    defaults: { cpus: null, memory_mb: null, disk_gb: null, arch: null },
  });

  it('FleetNetworkSchema requires every plane field, so a partial network cannot round-trip', () => {
    expect(FleetNetworkSchema.parse(fleetNetwork())).toMatchObject({ name: 'brokkr-net', dhcp: false });
    expect(() => FleetNetworkSchema.parse({ cidr: '192.168.200.0/24', bmcCidr: '192.168.105.0/24' })).toThrow();
  });

  it('FleetTombstoneSchema carries the base-declared flag a prune has to consult', () => {
    expect(FleetTombstoneSchema.parse({ name: 'cpu-3', zone: 'sim-zone', baseDeclared: true })).toEqual({
      name: 'cpu-3',
      zone: 'sim-zone',
      baseDeclared: true,
    });
    expect(() => FleetTombstoneSchema.parse({ name: 'cpu-3', zone: 'sim-zone' })).toThrow();
  });

  it('FleetNodeSchema keeps arch and network_type explicit rather than optional', () => {
    expect(FleetNodeSchema.parse(fleetNode({ arch: 'arm64', network_type: 'public' }))).toMatchObject({
      arch: 'arm64',
      network_type: 'public',
    });
    const { arch, ...noArch } = fleetNode();
    void arch;
    expect(() => FleetNodeSchema.parse(noArch)).toThrow();
    expect(() => FleetNodeSchema.parse(fleetNode({ network_type: 'bridged' }))).toThrow();
  });

  it('putFleetConfig accepts a network block and a prune list, and leaves both optional', () => {
    const route = contract.putFleetConfig;
    if (!isAppRoute(route) || !route.body) throw new Error('putFleetConfig has no body');
    const base = {
      mode: 'vm',
      nodes: [fleetNode()],
      baremetal: { nics: [], arch: 'amd64', bmcDefaults: { username: '', password: '' }, nodes: [] },
    };
    expect(route.body.parse(base)).not.toHaveProperty('prune');
    expect(route.body.parse({ ...base, network: fleetNetwork({ dhcp: true }), prune: ['cpu-3'] })).toMatchObject({
      network: { dhcp: true },
      prune: ['cpu-3'],
    });
  });

  it('previewFleetApplyPlan requires a draft topology and returns the same plan shape as the applied one', () => {
    const route = contract.previewFleetApplyPlan;
    if (!isAppRoute(route) || !route.body) throw new Error('previewFleetApplyPlan has no body');
    expect(route.body.parse({ nodes: [fleetNode()] }).nodes).toHaveLength(1);
    expect(() => route.body.parse({})).toThrow();
    expect(route.responses[200]).toBe(contract.getFleetApplyPlan.responses[200]);
  });

  it('FleetNodeEffectiveSchema requires the nullable effective IP fields', () => {
    expect(FleetNodeEffectiveSchema.parse(fleetNode({ effective_ip: null, effective_bmc_ip: null }))).toMatchObject({
      effective_ip: null,
      effective_bmc_ip: null,
    });
    expect(() => FleetNodeEffectiveSchema.parse(fleetNode())).toThrow();
  });

  it('FleetConfigSchema requires effective_ip/effective_bmc_ip on each node', () => {
    const good = fleetConfig([fleetNode({ effective_ip: '192.168.200.10', effective_bmc_ip: '192.168.105.10' })]);
    expect(FleetConfigSchema.parse(good).nodes[0].effective_ip).toBe('192.168.200.10');
    expect(() => FleetConfigSchema.parse(fleetConfig([fleetNode()]))).toThrow();
  });

  it('TestResultSchema parses recursively nested steps two levels deep', () => {
    const att = { name: 'serial', source: 'cc-serial.log', type: 'text/plain' };
    const leaf = { name: 'leaf', status: 'passed', durationMs: 5, steps: [], attachments: [att] };
    const parent = { name: 'parent', status: 'failed', durationMs: null, steps: [leaf], attachments: [] };
    const parsed = TestResultSchema.parse({
      runId: 'r1',
      summary: { total: 1, passed: 0, failed: 1, broken: 0, skipped: 0, unknown: 0 },
      tests: [
        {
          name: 'case',
          status: 'failed',
          durationMs: 10,
          message: 'boom',
          trace: 'at x',
          steps: [parent],
          attachments: [],
        },
      ],
      runLogs: [att],
    });
    expect(parsed.tests[0]?.steps[0]?.steps[0]?.name).toBe('leaf');
    expect(parsed.tests[0]?.steps[0]?.steps[0]?.attachments[0]?.source).toBe('cc-serial.log');
  });

  it('ResultStatusSchema rejects an unknown status', () => {
    expect(ResultStatusSchema.parse('broken')).toBe('broken');
    expect(() => ResultStatusSchema.parse('flaky')).toThrow();
  });

  it('PlanJsonSchema accepts select any and rejects sideways', () => {
    const base = { name: 'p', steps: [{ step: 'provision' }] };
    expect(PlanJsonSchema.parse({ ...base, select: 'any' }).select).toBe('any');
    expect(PlanJsonSchema.parse(base).select).toBeUndefined();
    expect(() => PlanJsonSchema.parse({ ...base, select: 'sideways' })).toThrow();
  });

  it('PostTestEventSchema defaults level to info and rejects an unknown level', () => {
    expect(PostTestEventSchema.parse({ message: 'm' }).level).toBe('info');
    expect(PostTestEventSchema.parse({ message: 'm', level: 'success' }).level).toBe('success');
    expect(() => PostTestEventSchema.parse({ message: 'm', level: 'debug' })).toThrow();
  });

  it('putFleetConfig body strips the effective_* keys off a node (GET→PUT round-trip safe)', () => {
    const route = contract.putFleetConfig;
    if (!isAppRoute(route) || !route.body) throw new Error('putFleetConfig body missing');
    const parsed = route.body.parse({
      mode: 'vm',
      nodes: [fleetNode({ effective_ip: '192.168.200.10', effective_bmc_ip: '192.168.105.10' })],
      baremetal: { nics: [], arch: 'amd64', bmcDefaults: { username: '', password: '' }, nodes: [] },
    });
    expect(parsed.nodes[0]).not.toHaveProperty('effective_ip');
    expect(parsed.nodes[0]).not.toHaveProperty('effective_bmc_ip');
  });

  it('FleetVerifyReportSchema.mode narrows to vm/baremetal/unknown and rejects other strings', () => {
    const base = { status: 'healthy' as const, findings: [], summary: { checked: 0, ok: 0, findings: 0 } };
    for (const mode of ['vm', 'baremetal', 'unknown'] as const) {
      expect(FleetVerifyReportSchema.parse({ ...base, mode }).mode).toBe(mode);
    }
    expect(() => FleetVerifyReportSchema.parse({ ...base, mode: 'qemu' })).toThrow();
  });

  it('StackSlotSchema accepts slot 0 and 46', () => {
    expect(StackSlotSchema.parse(0)).toBe(0);
    expect(StackSlotSchema.parse(46)).toBe(46);
  });

  it('StackSlotSchema rejects 47, -1, and a non-integer', () => {
    expect(() => StackSlotSchema.parse(47)).toThrow();
    expect(() => StackSlotSchema.parse(-1)).toThrow();
    expect(() => StackSlotSchema.parse(1.5)).toThrow();
  });

  it('StackConfigSchema carries the effective slot', () => {
    const base = {
      seeded: true,
      knobs: { hub: [], spoke: [] },
      ports: { hub: [], spoke: [] },
      servicePorts: [],
      values: { hub: {}, spoke: {} },
      topology: { zones: 1, bridges: 1 },
      identity: { pg: { user: 'u', password: 'p', db: 'd' }, orgId: 'o' },
      osLayerCache: { originHost: '', resolvers: '' },
      lan: { expose: false },
      telemetry: { enable: false },
      slot: 2,
    };
    expect(StackConfigSchema.parse(base).slot).toBe(2);
    expect(() => StackConfigSchema.parse({ ...base, slot: 47 })).toThrow();
  });

  it('putStackConfig body accepts an optional slot and declares a 409 conflict response', () => {
    const route = contract.putStackConfig;
    if (!isAppRoute(route) || !route.body) throw new Error('putStackConfig body missing');
    expect(route.body.parse({ entries: {}, slot: 3 }).slot).toBe(3);
    expect(route.body.parse({ entries: {} }).slot).toBeUndefined();
    expect(() => route.body.parse({ entries: {}, slot: 47 })).toThrow();
    expect(route.responses[409]).toBeDefined();
    expect(route.responses[409].parse({ error: 'slot 3 already claimed by /other/wt' })).toEqual({
      error: 'slot 3 already claimed by /other/wt',
    });
  });
});
