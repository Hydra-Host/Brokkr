import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { EMPTY, Subject, type Observable } from 'rxjs';
import { z } from 'zod';

import { getErrorMessage } from '../common/errors';
import { hubApiFetch, hubApiSignIn, simDeviceUuid } from '../common/hub-client';
import { isSafeRunId } from '../common/run-id';
import {
  DiskLayoutsSchema,
  LayerGroupSchema,
  LayerOptionSchema,
  StorageConfigSchema,
  TestEventLevelSchema,
  type Customizations,
  type DiskLayouts,
  type DiskLayoutSelection,
  type LayerCatalog,
  type PostTestEvent,
  type ResultStatus,
  type TestEvent,
  type TestResult,
  type TestResultAttachment,
  type TestResultCase,
  type TestScenario,
} from '../contract';
import { PgService } from '../datastore/pg.service';
import * as db from '../db/db';
import { FleetExecService } from '../fleet/fleet-exec.service';
import { FleetTopologyService } from '../fleet/fleet-topology.service';
import { RunLedgerService } from '../ledger/run-ledger.service';
import { PORTS, URLS } from '../ports';
import { listResultsDirs, RESULTS_ROOT, resultsDir } from '../results-root';
import { runBacklog, RunnerService, type RunState } from '../runner/runner.service';
import { RunsService } from '../runs/runs.service';
import { OverlayStoreService } from '../services/overlay-store';
import { ProcessComposeClient } from '../services/process-compose.client';
import { RosterService } from '../services/roster.service';
import { planCatalog, planForScenario } from './test-plan';

const LOCAL_NS = '5d4e0c4a-1f7c-4f4e-9c4e-1d8d2a3b4c5d';

const HubServerCatalogSchema = z
  .object({
    lifecycleStatus: z.union([z.string(), z.object({ value: z.string() }).passthrough()]).nullish(),
    status: z.union([z.string(), z.object({ value: z.string() }).passthrough()]).nullish(),
    specs: z
      .object({ gpu: z.object({ model: z.string().nullish() }).passthrough().nullish() })
      .passthrough()
      .nullish(),
    availableBaseLayers: z.array(z.object({ slug: z.string(), name: z.string() }).passthrough()).optional(),
    // passthrough variants: the strip-mode contract schemas would rewrite the hub payload (dropping
    // option fields like availability), and this proxy must forward valid payloads unchanged.
    availableComponentLayersByBase: z
      .record(
        z.string(),
        z.array(LayerGroupSchema.extend({ options: z.array(LayerOptionSchema.passthrough()) }).passthrough()),
      )
      .optional(),
  })
  .passthrough();

const VitestAssertionSchema = z.object({
  title: z.string().default(''),
  fullName: z.string().default(''),
  status: z.string().default('unknown'),
  duration: z.number().nullable().optional(),
  failureMessages: z.array(z.string()).default([]),
});

const VitestJsonSchema = z.object({
  testResults: z
    .array(
      z.object({
        name: z.string().default(''),
        status: z.string().default('unknown'),
        message: z.string().default(''),
        assertionResults: z.array(VitestAssertionSchema).default([]),
      }),
    )
    .default([]),
});

const StorageLayoutsSchema = z.object({
  configs: z.array(StorageConfigSchema).default([]),
  default: DiskLayoutsSchema.shape.default.default({}),
});

function caseStatus(raw: string): ResultStatus {
  switch (raw) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'pending':
    case 'todo':
      return 'skipped';
    default:
      return 'unknown';
  }
}

export function bmDeviceUuid(mac: string): string {
  const nsBytes = Buffer.from(LOCAL_NS.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(`baremetal:${mac.toLowerCase()}`, 'utf8'))
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface ScenarioDef extends TestScenario {
  vitestFile: string;
  live?: boolean;
}

const TS_E2E = 'tests/ts-e2e';

const VM_ONLY_SCENARIOS = new Set(['vrrp-failover', 'spoke-failover', 'spoke-resume']);

const SCENARIOS: ScenarioDef[] = [
  {
    id: 'plan-custom',
    label: 'Custom Sequence',
    description:
      'Assemble a sequence from modular steps (provision, reprovision, power-cycle, verify-os, end-rental, ...) and run the whole thing on one node in a single deploy — instead of firing each scenario one by one. Clone a preset or build from scratch in the picker, then add/remove/reorder steps. Live, slow + destructive.',
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'plan',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'smoke',
    label: 'Smoke (fast)',
    description:
      'Fast E2E checks against the live stack, branched on the fleet mode. VM mode: seeded nodes + Device rows, per-VM agent, BMC simulators, chain endpoint. Bare-metal mode: the box’s hub identity, a read-only BMC probe, iPXE assets, the operator-set proxy-DHCP preconditions, the spoke’s DHCP sockets, base-OS artifact and chain endpoint. Excludes the slow lifecycle.',
    pinNode: false,
    destructive: false,
    vitestFile: `${TS_E2E}/test-smoke.test.ts`,
  },
  {
    id: 'redis-acl',
    label: 'Zone Redis ACL (fast)',
    description:
      'Creates a throwaway zone via the API and verifies the per-zone Redis ACL feature: show-once credential returned, brokkr-spoke-<zoneId> user scoped to its own + results namespaces (denied elsewhere and on admin/dangerous commands), rotate revokes the old password, delete removes the user. Skips when the hub runs with REDIS_ACL_MANAGEMENT_ENABLED off. Non-destructive to the seeded fleet.',
    pinNode: false,
    destructive: false,
    vitestFile: `${TS_E2E}/test-zone-redis-acl.test.ts`,
  },
  {
    id: 'lifecycle-quick',
    label: 'Lifecycle: quick',
    description:
      'Quick lifecycle journey on one node: provision -> end-rental (deprovision). Live stack, slow + destructive. Pick targets or let it auto-select the first INVENTORY device. Multi-select which steps to run in the confirm modal.',
    pinNode: true,
    destructive: true,
    live: true,
    vitestFile: `${TS_E2E}/plan.test.ts`,
    steps: [
      { value: 'provision', label: 'Provision' },
      { value: 'deprovision', label: 'Deprovision' },
    ],
  },
  {
    id: 'lifecycle-full',
    label: 'Lifecycle: full',
    description:
      'Full lifecycle journey on one node: provision -> power-cycle -> reprovision -> end-rental (deprovision). Live stack, slow + destructive. Captures the Redis/DB/IPMI timeline + serial as step attachments.',
    pinNode: true,
    destructive: true,
    live: true,
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'rescue-boot',
    label: 'Rescue boot',
    description:
      "Rescue-boot a machine: provision one if none is provisioned, boot it into the live rescue OS, verify it's running a live OS, then exit rescue back to the installed OS (deprovision if it was pulled from inventory). Pick the rescue OS in the popup -- this is the admin-only choice (the customer flow is always single-OS). Live, slow + destructive.",
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'rescue',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'custom-ipxe',
    label: 'Custom iPXE',
    description:
      'Provision with operatingSystem=ipxe-custom + a trusted iPXE URL: asserts the validator negatives (ipxe-custom without a URL, and a URL on a non-custom OS both 400) then provisions and verifies the hub stored the URL for the boot chain (device:{id}:config:ipxe_url), then end-rental. Plumbing-only -- there is no reachable iPXE server in the sim, so it does not chainload an external menu. Live, slow + destructive.',
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'ipxe',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'cloud-init',
    label: 'Cloud-init',
    description:
      'Provision with a user-data payload and verify each cloud-config section (write_files / users / runcmd) landed on the booted OS. Live, slow + destructive.',
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'cloudinit',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'layer-test',
    label: 'Layer Composition',
    description:
      "Provision a node WITH a chosen OS-layer stack (base + components), verify each layer landed on the booted OS, then end-rental back to INVENTORY. Pick layers in the popup -- eligibility is the hub's (GPU driver/CUDA layers appear only when a real GPU is discovered). Live stack, slow + destructive.",
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'layers',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'base-os-test',
    label: 'Base OS Scan',
    description:
      'Cycle a node through each selected base OS: provision -> verify distro/version over SSH -> reprovision with the next, repeating until every chosen base OS passes, then end-rental back to INVENTORY. Pick which base OSes in the popup (default all eligible). Live stack, slow + destructive -- one OS deploy per base OS.',
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'baseos',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'disk-layout',
    label: 'Disk layout',
    description:
      "Cycle a node through each selected disk layout: provision with that layout (group + config + filesystem for OS and/or data) -> verify the disk landed on the booted OS (lsblk/findmnt + lvs/vgs for LVM + mdadm for RAID) -> reprovision with the next, then end-rental back to INVENTORY. Pick a node + layout options (with select-all) in the popup -- options are enumerated from the node's live storageLayouts (RAID combos appear only on multi-disk groups). Live stack, slow + destructive.",
    pinNode: true,
    destructive: true,
    live: true,
    picker: 'disklayout',
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'commissioning',
    label: 'Commissioning',
    description:
      'Full device commissioning on one node: real network scan against the sim BMC zone, faked iPXE/IPMI Redis enrichment, then the commission saga drives qualify (provision -> deprovision) to completion -- the device lands in INVENTORY as part of inventory. Live stack, slow + destructive. Left commissioned (no reset).',
    pinNode: true,
    destructive: true,
    live: true,
    disabled: true,
    disabledReason: 'Requires admin API endpoints not yet ported to main API',
    vitestFile: `${TS_E2E}/test-commissioning.test.ts`,
  },
  {
    id: 'spoke-failover',
    label: 'Spoke: failover',
    description:
      'With >=2 spokes (HA replicas of one zone), provision a node, detect the spoke working the saga, then kill it. Another spoke on the shared BullMQ queue must pick the job up (stalled-job redelivery + device-lock TTL) and reach PROVISIONED, then end-rental to INVENTORY. Requires >=2 HA spoke replicas (fails fast otherwise). Live, slow + destructive.',
    pinNode: true,
    destructive: true,
    live: true,
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'spoke-resume',
    label: 'Spoke: restart-resume',
    description:
      'With >=2 spokes, provision a node, detect the spoke working the saga, then restart it mid-work. The saga must resume from its Redis-persisted plan (no restart-from-zero) and still reach PROVISIONED, then end-rental to INVENTORY. Requires >=2 HA spoke replicas (fails fast otherwise). Live, slow + destructive.',
    pinNode: true,
    destructive: true,
    live: true,
    vitestFile: `${TS_E2E}/plan.test.ts`,
  },
  {
    id: 'vrrp-failover',
    label: 'VRRP: VIP failover',
    description:
      'Drives the real VrrpReconcilerService against live Redis via the ip shim: leader binds the VIP, follower binds nothing, failover moves it to the new leader, a cleared atom releases it. Live, non-destructive (own zone prefix + temp state, no real interfaces touched).',
    pinNode: false,
    destructive: false,
    live: true,
    vitestFile: `${TS_E2E}/vrrp-failover.test.ts`,
  },
];

@Injectable()
export class TestService {
  private readonly log = new Logger(TestService.name);
  private readonly eventSubjects = new Map<string, Subject<TestEvent>>();

  constructor(
    private readonly runner: RunnerService,
    private readonly roster: RosterService,
    private readonly pc: ProcessComposeClient,
    private readonly overlay: OverlayStoreService,
    private readonly fleet: FleetTopologyService,
    private readonly exec: FleetExecService,
    private readonly pg: PgService,
    private readonly ledger: RunLedgerService,
    private readonly runs: RunsService,
  ) {
    mkdirSync(RESULTS_ROOT, { recursive: true });
  }

  scenarios(): TestScenario[] {
    return SCENARIOS.map(({ vitestFile, live, ...pub }) => ({ ...pub, ...(this.vmOnlyBlock(pub.id) ?? {}) }));
  }

  private vmOnlyBlock(scenarioId: string): { disabled: true; disabledReason: string } | null {
    if (!VM_ONLY_SCENARIOS.has(scenarioId) || this.overlay.fleetMode() !== 'baremetal') return null;
    return {
      disabled: true,
      disabledReason: 'Requires the VM simulator fleet (multi-spoke HA / VRRP); the stack is in bare-metal mode',
    };
  }

  planCatalog() {
    return planCatalog({ operatorPubkey: this.exec.devPubkey().pubkey });
  }

  // the run finalize and the event stream close together, or a live timeline subscriber never sees the end
  private finish(run: RunState, code: number | null): void {
    this.runner.finalize(run, code);
    this.completeEventSubject(run.runId);
  }

  purge(runId?: string): number {
    // the targeted path is built by resultsDir, never rejoined here: an unsafe id must be rejected by
    // the one shared rule rather than reach a recursive delete
    const targets = runId ? [{ runId, path: resultsDir(runId) }] : listResultsDirs();
    // Never delete a running run's state: its PTY child still drives destructive sagas, and freeing
    const running = new Set(this.runs.active('test').map((r) => r.runId));
    const undeleted = new Set<string>();
    let n = 0;
    for (const target of targets) {
      if (running.has(target.runId)) continue;
      try {
        rmSync(target.path, { recursive: true, force: true });
        this.evict(target.runId);
        n++;
      } catch (error) {
        undeleted.add(target.runId);
        this.log.warn(`purge failed for ${target.path}: ${getErrorMessage(error)}`);
      }
    }
    // sweeps rows no results dir backs, e.g. history migrated from the legacy table; through forget
    // rather than bulk sql so each run's log goes now, not at the 1h orphan sweep
    if (!runId) {
      try {
        // a dir that would not delete keeps its row: forgetting it strands the results with nothing
        // left pointing at them, and the run disappears from the ui while still occupying disk
        for (const id of db.listTerminalRunIds('test')) if (!undeleted.has(id)) this.ledger.forget(id);
      } catch (error) {
        this.log.warn(`ledger sweep failed: ${getErrorMessage(error)}`);
      }
    }
    this.log.log(`purged ${n} test result dir(s)${runId ? ` (${runId})` : ''}`);
    return n;
  }

  /** A dir name is not proof of ownership: an id it derives can collide with a live run of another
   *  section, and fleet busyness is read off the very map an eviction would drop it from. */
  private evict(runId: string): void {
    if (!isSafeRunId(runId)) return;
    const live = this.runner.getRun(runId);
    if (live !== undefined && live.section !== 'test') return;
    this.runner.remove(runId);
    this.ledger.forget(runId);
  }

  /** getRunRow spans every section, so the test event routes have to re-narrow: a stack or fleet runId
   *  would otherwise take timeline writes and open a live stream through /api/tests. */
  private testRunRow(runId: string): db.RunRow {
    const row = db.getRunRow(runId);
    if (row?.section !== 'test') throw new NotFoundException(`unknown run '${runId}'`);
    return row;
  }

  addEvent(runId: string, event: PostTestEvent): TestEvent {
    this.testRunRow(runId);
    const row = db.insertEvent({
      run_id: runId,
      timestamp: Date.now(),
      source: event.source,
      level: event.level,
      message: event.message,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
    });
    const evt: TestEvent = {
      id: row.id,
      runId,
      timestamp: row.timestamp,
      source: event.source,
      level: event.level,
      message: event.message,
      metadata: event.metadata ?? null,
    };
    this.eventSubjects.get(runId)?.next(evt);
    return evt;
  }

  listEvents(runId: string): TestEvent[] {
    this.testRunRow(runId);
    return db.getEvents(runId).map((r) => ({
      id: r.id,
      runId: r.run_id,
      timestamp: r.timestamp,
      source: r.source,
      level: TestEventLevelSchema.catch('info').parse(r.level),
      message: r.message,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    }));
  }

  eventStream(runId: string): { backlog: TestEvent[]; live$: Observable<TestEvent> } {
    const backlog = this.listEvents(runId);
    // a finished run's subject was completed and deleted — recreating one would hold a late
    // subscriber open forever; an empty live$ lets the controller emit backlog + done and close.
    if (this.testRunRow(runId).status !== 'running') return { backlog, live$: EMPTY };
    let sub = this.eventSubjects.get(runId);
    if (!sub) {
      sub = new Subject<TestEvent>();
      this.eventSubjects.set(runId, sub);
    }
    return { backlog, live$: sub };
  }

  private completeEventSubject(runId: string): void {
    const sub = this.eventSubjects.get(runId);
    if (sub) {
      sub.complete();
      this.eventSubjects.delete(runId);
    }
  }

  private resolveNode(nodeIndex: number): { nodeName: string; deviceId: string; pxeMac: string | null } {
    if (this.overlay.fleetMode() === 'baremetal') {
      const bmNodes = this.fleet.baremetalNodes();
      if (nodeIndex < 0 || nodeIndex >= bmNodes.length)
        throw new BadRequestException(
          `node index ${nodeIndex} out of range (bare-metal fleet has ${bmNodes.length} machines)`,
        );
      const node = bmNodes[nodeIndex]!;
      return { nodeName: node.name, deviceId: bmDeviceUuid(node.pxeMac), pxeMac: node.pxeMac };
    }
    const names = this.fleet.nodeNames();
    if (nodeIndex < 0 || nodeIndex >= names.length)
      throw new BadRequestException(`node index ${nodeIndex} out of range (fleet has ${names.length} nodes)`);
    return { nodeName: names[nodeIndex]!, deviceId: simDeviceUuid(nodeIndex), pxeMac: null };
  }

  async layerCatalogNative(nodeIndex: number): Promise<LayerCatalog> {
    const { nodeName, deviceId } = this.resolveNode(nodeIndex);
    const hubBase = URLS.hubBase;

    try {
      const jar = await hubApiSignIn(hubBase);

      const { code, body } = await hubApiFetch(hubBase, jar, 'GET', `/api/v1/servers/${deviceId}`);
      if (code !== 200 || !body) throw new Error(`get_server(${deviceId}) failed (${code}): ${JSON.stringify(body)}`);

      const parsed = HubServerCatalogSchema.safeParse(body);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        const detail = first ? `${first.path.join('.')}: ${first.message}` : 'unexpected shape';
        throw new Error(`hub server payload did not match the expected shape: ${detail}`);
      }
      const server = parsed.data;

      const lifecycle = server.lifecycleStatus ?? server.status;
      const lifecycleValue = typeof lifecycle === 'object' && lifecycle !== null ? lifecycle.value : lifecycle;
      const gpuModel = server.specs?.gpu?.model ?? null;

      return {
        node: nodeName,
        deviceId,
        gpuModel,
        lifecycleStatus: lifecycleValue ?? null,
        baseLayers: (server.availableBaseLayers ?? []).map((b) => ({ slug: b.slug, name: b.name })),
        componentsByBase: server.availableComponentLayersByBase ?? {},
      };
    } catch (e) {
      if (e instanceof TypeError && (e.message.includes('fetch') || e.message.includes('ECONNREFUSED'))) {
        throw new BadRequestException(`Hub API not reachable at ${hubBase}. Is the stack up? Bring up the hub first.`);
      }
      throw new BadRequestException(`layer catalog failed: ${getErrorMessage(e)}`);
    }
  }

  async layerCatalog(nodeIndex: number | string): Promise<LayerCatalog> {
    return this.layerCatalogNative(Number(nodeIndex));
  }

  async diskLayoutsNative(nodeIndex: number): Promise<DiskLayouts> {
    const { nodeName, deviceId } = this.resolveNode(nodeIndex);

    const layouts = await this.pg.getStorageLayouts(deviceId);
    if (!layouts)
      throw new BadRequestException(`device ${deviceId} has no seeded storageLayouts -- run \`task sim:seed\``);

    const parsed = StorageLayoutsSchema.safeParse(layouts);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first ? `${first.path.join('.')}: ${first.message}` : 'unexpected shape';
      throw new BadRequestException(`device ${deviceId} storageLayouts did not match the expected shape: ${detail}`);
    }

    return { node: nodeName, deviceId, configs: parsed.data.configs, default: parsed.data.default };
  }

  async diskLayouts(nodeIndex: number | string): Promise<DiskLayouts> {
    return this.diskLayoutsNative(Number(nodeIndex));
  }

  private resultsDir(runId: string): string {
    return resultsDir(runId);
  }

  private resultsFile(runId: string): string {
    return join(this.resultsDir(runId), 'results.json');
  }

  start(
    scenarioId: string,
    nodeIndex?: number | null,
    opts?: {
      base?: string;
      customizations?: Customizations;
      cloudInit?: string;
      rescueOs?: string;
      baseOses?: string[];
      ipxeUrl?: string;
      diskLayouts?: DiskLayoutSelection[];
      steps?: string[];
      plan?: string;
    },
  ): string {
    const sc = SCENARIOS.find((s) => s.id === scenarioId);
    if (!sc) throw new NotFoundException(`unknown test scenario '${scenarioId}'`);
    if (sc.disabled) throw new BadRequestException(sc.disabledReason ?? `scenario '${scenarioId}' is disabled`);
    const blocked = this.vmOnlyBlock(sc.id);
    if (blocked) throw new BadRequestException(blocked.disabledReason);

    let target = nodeIndex;
    if (sc.pinNode && target == null && this.overlay.fleetMode() === 'baremetal') {
      const bmNodes = this.fleet.baremetalNodes();
      if (bmNodes.length === 1) target = 0;
      else
        throw new BadRequestException(
          `bare-metal mode: pick the target machine explicitly (${bmNodes.length} in the fleet) — 'Auto' selects only from the VM roster`,
        );
    }

    const pinned = sc.pinNode && target != null;
    let nodeName: string | undefined;
    let bmPxeMac: string | null = null;
    if (pinned) {
      const resolved = this.resolveNode(target!);
      nodeName = resolved.nodeName;
      bmPxeMac = resolved.pxeMac;
      // One test per node: concurrent runs would race for the device lock, fleet VM, and qualify state machine.
      const conflict = this.runs.active('test').find((r) => r.nodeIndex === target);
      if (conflict) {
        throw new ConflictException(
          `node '${nodeName}' (index ${target}) already has a running test ` +
            `(runId=${conflict.runId}, ${conflict.label}). Cancel it first.`,
        );
      }
    }
    const layerSummary = opts?.customizations ? Object.values(opts.customizations).flat().join('+') : '';
    const base = pinned ? `${sc.label} [${nodeName}]` : sc.label;
    const label =
      sc.picker === 'layers' && (opts?.base || layerSummary)
        ? `${base} . ${opts?.base ?? ''} ${layerSummary}`.trim()
        : base;
    const run = this.runner.create({
      section: 'test',
      opId: scenarioId,
      label,
      nodeIndex: pinned ? target! : null,
    });

    const dir = this.resultsDir(run.runId);
    mkdirSync(dir, { recursive: true });

    const labPort = PORTS.lab;
    const env: Record<string, string> = {
      TEST_RUN_ID: run.runId,
      TEST_EVENTS_URL: `http://localhost:${labPort}/api/tests/runs/${run.runId}/events`,
    };
    if (pinned) {
      env.SIM_LC_DEVICE_INDEX = String(target);
      if (bmPxeMac) {
        env.SIM_LC_DEVICE_ID = bmDeviceUuid(bmPxeMac);
        env.SIM_LC_BOOT_MAC = bmPxeMac;
      }
    }
    env.SIM_LC_BASE = opts?.base ?? '';
    if (sc.picker === 'layers') {
      if (opts?.base) env.SIM_LAYERS_BASE = opts.base;
      env.SIM_LAYERS_CUSTOMIZATIONS = JSON.stringify(opts?.customizations ?? {});
    }
    if (sc.picker === 'cloudinit' && opts?.cloudInit) env.SIM_CLOUD_INIT = opts.cloudInit;
    if (sc.picker === 'rescue' && opts?.rescueOs) env.SIM_RESCUE_OS = opts.rescueOs;
    if (sc.picker === 'baseos' && opts?.baseOses?.length) env.SIM_BASEOS_LIST = JSON.stringify(opts.baseOses);
    if (sc.picker === 'ipxe' && opts?.ipxeUrl) env.SIM_IPXE_URL = opts.ipxeUrl;
    if (sc.picker === 'disklayout' && opts?.diskLayouts?.length)
      env.SIM_DISK_LAYOUTS = JSON.stringify(opts.diskLayouts);
    if (sc.vitestFile === `${TS_E2E}/plan.test.ts`) {
      if (sc.picker === 'plan') {
        if (!opts?.plan) throw new BadRequestException('a custom sequence requires an assembled plan');
        env.SIM_PLAN = opts.plan;
      } else {
        env.SIM_PLAN = JSON.stringify(planForScenario(sc.id, opts));
      }
    }
    // Always set SIM_LC_STEPS explicitly (empty = "all") so an inherited value on the lab process can't leak into the vitest child.
    if (sc.steps) env.SIM_LC_STEPS = opts?.steps?.length ? opts.steps.join(',') : '';
    if (sc.live) {
      env.SIM_LC_LIVE = '1';
      env.SIM_LC_ATOM_VALUES = 'full';
    }

    this.log.log(`test run ${run.runId}: ${label}`);
    this.runner.emit(run, `\r\n[test] ${label}\r\n\r\n`);

    // Pinned device is reset to clean INVENTORY first — stale state from a prior test silently breaks the next provision.
    const runChain = async () => {
      const offsets = (await this.roster.defs()).map((d) => ({
        id: d.id,
        offset: this.fileSize(this.pc.logFile(d.id)),
      }));
      if (run.cancelled) {
        this.finish(run, null);
        return;
      }
      if (pinned && nodeName) {
        this.runner.emit(run, `[pre-test reset] ${nodeName} -> INVENTORY\r\n`);
        const resetCode = await this.runner.spawn(run, 'python', ['-m', 'local.reset_device', nodeName]);
        if (resetCode !== 0) {
          this.runner.emit(run, `\r\n[pre-test reset] FAILED (exit ${resetCode}) -- aborting test\r\n`);
          this.finish(run, resetCode);
          return;
        }
        this.runner.emit(run, `[pre-test reset] complete\r\n\r\n`);
      }
      if (run.cancelled) {
        this.finish(run, null);
        return;
      }
      const vitestArgs = [
        'vitest',
        'run',
        sc.vitestFile,
        '--config',
        'tests/ts-e2e/vitest.config.ts',
        '--reporter=verbose',
        '--reporter=json',
        `--outputFile.json=${this.resultsFile(run.runId)}`,
      ];
      const code = await this.runner.spawnPty(run, 'npx', vitestArgs, env);
      this.collectLogs(run, dir, offsets);
      this.runner.emit(run, `\r\n[results] captured hub/spoke logs + breakdown -- see the Results tab.\r\n`);
      this.finish(run, code);
    };
    // Any mid-chain throw must still land the run in a terminal state — else it stays 'running' forever and the unhandled rejection crashes the lab API.
    void runChain().catch((e) => {
      this.runner.emit(run, `\r\n[test] run failed: ${getErrorMessage(e)}\r\n`);
      this.finish(run, 1);
    });
    return run.runId;
  }

  result(runId: string): TestResult {
    const dir = this.resultsDir(runId);
    // a dir with no row is legacy history and still readable; a row of another section is not this
    // route's to answer for, even though it would only ever yield an empty result
    if (db.getRunRow(runId)?.section !== 'test' && !existsSync(dir))
      throw new NotFoundException(`unknown run '${runId}'`);
    const tests = this.parseCases(runId);
    const summary = { total: tests.length, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
    for (const t of tests) summary[t.status] += 1;
    return { runId, summary, tests, runLogs: this.runLogsIn(dir) };
  }

  private parseCases(runId: string): TestResultCase[] {
    const path = this.resultsFile(runId);
    if (!existsSync(path)) return [];
    let report: z.infer<typeof VitestJsonSchema>;
    try {
      report = VitestJsonSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
      this.log.warn(`results.json unreadable for run ${runId}: ${getErrorMessage(error)}`);
      return [];
    }

    const cases: TestResultCase[] = [];
    for (const suite of report.testResults) {
      for (const a of suite.assertionResults) {
        const failure = a.failureMessages.join('\n\n');
        cases.push({
          name: a.fullName || a.title,
          status: caseStatus(a.status),
          durationMs: a.duration ?? null,
          message: failure ? (failure.split('\n    at ')[0] ?? failure) : null,
          trace: failure || null,
          steps: [],
          attachments: [],
        });
      }
      if (suite.assertionResults.length === 0 && suite.status === 'failed') {
        cases.push({
          name: `${basename(suite.name) || 'suite'} (no tests registered)`,
          status: 'broken',
          durationMs: null,
          message: suite.message || 'the suite failed before any test registered',
          trace: suite.message || null,
          steps: [],
          attachments: [],
        });
      }
    }
    return cases;
  }

  private fileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private sliceTo(src: string, offset: number, dst: string): void {
    try {
      if (!existsSync(src)) return;
      const buf = readFileSync(src);
      writeFileSync(dst, buf.subarray(offset <= buf.length ? offset : 0));
    } catch (error) {
      this.log.warn(`log slice failed for ${src}: ${getErrorMessage(error)}`);
    }
  }

  private collectLogs(run: RunState, dir: string, offsets: { id: string; offset: number }[]): void {
    for (const { id, offset } of offsets) {
      this.sliceTo(this.pc.logFile(id), offset, join(dir, `cc-${id}.log`));
    }
    try {
      writeFileSync(join(dir, 'cc-test-output.log'), runBacklog(run));
    } catch (error) {
      this.log.warn(`test output write failed for run ${run.runId}: ${getErrorMessage(error)}`);
    }
  }

  private runLogsIn(dir: string): TestResultAttachment[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith('cc-') && f.endsWith('.log') && this.fileSize(join(dir, f)) > 0)
      .sort((a, b) => (a === 'cc-test-output.log' ? 1 : b === 'cc-test-output.log' ? -1 : a.localeCompare(b)))
      .map((f) => ({
        name: f === 'cc-test-output.log' ? 'test output' : f.replace(/^cc-|\.log$/g, ''),
        source: f,
        type: 'text/plain',
      }));
  }

  attachmentStream(runId: string, source: string): StreamableFile {
    const safe = basename(source);
    const path = join(this.resultsDir(runId), safe);
    if (!existsSync(path)) throw new NotFoundException(`attachment '${source}' not found`);
    return new StreamableFile(createReadStream(path), { type: 'text/plain; charset=utf-8', disposition: 'inline' });
  }
}
