import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as yaml from 'js-yaml';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, arch as osArch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import { REDACTED } from '../common/redact';

const execFileP = promisify(execFile);

/** An empty password stays empty: masking it would make "unset" and "hidden" read the same. */
export const maskBmcPassword = (password: string | undefined): string => (password ? REDACTED : (password ?? ''));

const ChainStampSchema = z.object({ chain_base_url: z.string().optional() }).passthrough();

const ipxeBuildsDir = (): string => process.env.LOCAL_IPXE_BUILDS_DIR ?? '/opt/brokkr/ipxe-builds';

import {
  ApplyPlanSchema,
  CONSOLE_PORT_BASE,
  FleetPendingSchema,
  ipAtOffset,
  ipInCidr,
  ipToInt,
  isIpv4,
  networkBase,
  NODE_IP_BASE,
  parseCidr,
  type ApplyPlan,
  type BareMetalConfig,
  type BareMetalConfigWrite,
  type BareMetalNode,
  type FleetConfig,
  type FleetDefaults,
  type FleetMode,
  type FleetNetwork,
  type FleetNodeEffective,
  type FleetPending,
  type HostNic,
  type RejectedEntry,
} from '@repo/local-lab-contract';
import { isRecord } from '@repo/utils';
import { ccBuildInfo } from '../common/build-info';
import { isIpv4Family } from '../common/net';
import type { FleetNode, HostInfo, PciDevice } from '../contract';
import { RunnerService } from '../runner/runner.service';
import { readAppliedMode } from '../services/applied-manifest';
import { OverlayStoreService } from '../services/overlay-store';
import { RenderedConfigService } from '../services/rendered-config.service';
import type { EffectiveDefaults, EffectiveNetwork, EffectiveNode } from './effective-fleet';
import { EffectiveDefaultsSchema, EffectiveNetworkSchema, EffectiveNodeSchema } from './effective-fleet';

const isMac = (s: string): boolean => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(s);

const NIC_MODELS = ['virtio', 'e1000e', 'e1000', 'rtl8139', 'vmxnet3'] as const;
const nicModel = (v: unknown): (typeof NIC_MODELS)[number] => NIC_MODELS.find((m) => m === v) ?? 'virtio';

const networkView = (raw: EffectiveNetwork): FleetNetwork => ({
  name: raw.name ?? '',
  cidr: raw.cidr ?? '',
  bmcCidr: raw.bmc_cidr ?? '',
  domain: raw.domain ?? '',
  dhcp: raw.dhcp === true,
  renderedNetplan: raw.rendered_netplan === true,
});

const networkSpec = (n: FleetNetwork): Record<string, string | boolean> => ({
  name: n.name,
  cidr: n.cidr,
  bmc_cidr: n.bmcCidr,
  domain: n.domain,
  dhcp: n.dhcp,
  rendered_netplan: n.renderedNetplan,
});

const draftDefaults = (base: Record<string, unknown>, d: FleetDefaults): Record<string, unknown> => {
  const out = { ...base };
  for (const key of ['cpus', 'memory_mb', 'disk_gb', 'arch'] as const) {
    if (d[key] === null) delete out[key];
    else out[key] = d[key];
  }
  return out;
};

const RawFleetDocSchema = z
  .object({ network: z.unknown().optional(), defaults: z.unknown().optional(), nodes: z.array(z.unknown()).optional() })
  .passthrough();

const nodeName = (n: unknown): string =>
  typeof n === 'object' && n !== null && 'name' in n && typeof n.name === 'string' ? n.name : '<unknown>';

const zodSummary = (err: z.ZodError): string =>
  err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

type BmcCred = { user: string; pass: string };
type BmcCredFile = Record<string, BmcCred>;

const NON_UPLINK_NIC_RE = /^(lo|br-brokkr|virbr|docker|veth|tun|tap|tailscale|utun)/;

/** Mirrors apps/local-sim schema.py Defaults — what the engine applies when neither the node nor the
 *  fleet declares a value. */
const ENGINE_DEFAULTS = { cpus: 2, memory_mb: 4096, disk_gb: 40 } as const;

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

@Injectable()
export class FleetTopologyService {
  private readonly log = new Logger(FleetTopologyService.name);
  private pendingCache: { at: number; val: FleetPending } | null = null;
  // bumped on every fleet mutation so a slow in-flight diff can't overwrite a freshly-cleared cache.
  private pendingGen = 0;

  constructor(
    private readonly runner: RunnerService,
    private readonly overlay: OverlayStoreService,
    private readonly rendered: RenderedConfigService,
  ) {}

  /** Nodes are enabled-only, sorted by index — must match the engine's rendered fleet.yml ordering. */
  private rawFleet(): { network: unknown; defaults: unknown; nodes: unknown[] } {
    const mirror = this.overlay.fleetConfig();
    if (mirror) {
      const nodes = Object.entries(mirror.nodes)
        .filter(([, n]) => n.enable !== false)
        .sort(([, a], [, b]) => Number(a.index ?? 0) - Number(b.index ?? 0))
        .map(([name, n]) => {
          const { enable, index, ...spec } = n;
          void enable;
          void index;
          return { name, ...spec };
        });
      return { network: mirror.network, defaults: mirror.defaults, nodes };
    }
    const path = process.env.LOCAL_FLEET_PATH;
    if (path && existsSync(path)) {
      // wrap with the same prefix as the node checks so a malformed fleet.yml surfaces consistently
      // (StatusService rethrows 'fleet config invalid' rather than masking it as an empty fleet).
      const doc = RawFleetDocSchema.safeParse(yaml.load(readFileSync(path, 'utf8')) ?? {});
      if (!doc.success) throw new Error(`fleet config invalid: ${zodSummary(doc.error)}`);
      return { network: doc.data.network ?? {}, defaults: doc.data.defaults ?? {}, nodes: doc.data.nodes ?? [] };
    }
    return { network: {}, defaults: {}, nodes: [] };
  }

  /** Parse the raw fleet through the effective schemas. A bad node THROWS rather than being skipped:
   *  IPs and device UUIDs are index-derived, so a silent skip corrupts every later node. */
  private activeFleet(): { network: EffectiveNetwork; defaults: EffectiveDefaults; nodes: EffectiveNode[] } {
    const raw = this.rawFleet();
    const network = EffectiveNetworkSchema.safeParse(raw.network);
    if (!network.success) throw new Error(`fleet config invalid: ${zodSummary(network.error)}`);
    const defaults = EffectiveDefaultsSchema.safeParse(raw.defaults);
    if (!defaults.success) throw new Error(`fleet config invalid: ${zodSummary(defaults.error)}`);
    const nodes = raw.nodes.map((n) => {
      const parsed = EffectiveNodeSchema.safeParse(n);
      if (!parsed.success) throw new Error(`fleet config invalid: node '${nodeName(n)}': ${zodSummary(parsed.error)}`);
      return parsed.data;
    });
    return { network: network.data, defaults: defaults.data, nodes };
  }

  nodeNames(): string[] {
    return this.activeFleet().nodes.map((n) => n.name);
  }

  baremetalNodes(): { name: string; pxeMac: string }[] {
    return this.baremetalView().nodes.map((n) => ({ name: n.name, pxeMac: n.pxe_mac }));
  }

  hostFacts(): Omit<HostInfo, 'ccBuild'> {
    const os = platform();
    const arch = osArch() === 'x64' ? 'amd64' : osArch() === 'arm64' ? 'arm64' : osArch();
    return {
      os,
      arch,
      passthroughSupported: os === 'linux' && arch === 'amd64',
      lanIp: this.lanIp(),
    };
  }

  async hostInfo(): Promise<HostInfo> {
    return { ...this.hostFacts(), ccBuild: await ccBuildInfo() };
  }

  private lanIp(): string {
    const { network } = this.activeFleet();
    const cand: string[] = [];
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const ip = a.address;
        if (
          (network.cidr && ipInCidr(ip, network.cidr)) ||
          (network.bmc_cidr && ipInCidr(ip, network.bmc_cidr)) ||
          ip.startsWith('192.168.122.') ||
          ip.startsWith('172.')
        )
          continue;
        cand.push(ip);
      }
    }
    return (
      cand.find((ip) => ip.startsWith('192.168.')) ?? cand.find((ip) => ip.startsWith('10.')) ?? cand[0] ?? '127.0.0.1'
    );
  }

  pciDevices(): Promise<PciDevice[]> {
    if (this.hostFacts().os !== 'linux') return Promise.resolve([]);
    return new Promise((resolve) => {
      let out = '';
      const c = spawn('lspci', ['-Dnn'], { stdio: ['ignore', 'pipe', 'ignore'] });
      c.stdout.on('data', (b) => (out += b.toString()));
      c.on('error', () => resolve([]));
      c.on('close', () => resolve(this.parsePci(out)));
    });
  }

  private parsePci(out: string): PciDevice[] {
    const re = /^(\S+)\s+(.+?)\s+\[([0-9a-fA-F]{4})\]:\s+(.+?)\s+\[([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\]/;
    const devices: PciDevice[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      const [, addr, , cls, name, vendor] = m;
      const v = vendor.toLowerCase();
      let type: PciDevice['type'] | null = null;
      if (cls.startsWith('03')) type = v === '10de' ? 'nvidia-gpu' : v === '1002' ? 'amd-gpu' : 'gpu';
      else if (v === '15b3') type = 'mellanox';
      else if (cls.startsWith('02') || cls === '0c06') type = 'nic';
      if (!type) continue;
      devices.push({ addr, type, label: `${name} [${m[5]}:${m[6]}]` });
    }
    return devices;
  }

  hostNics(): HostNic[] {
    if (this.hostFacts().os !== 'linux') return [];
    const nics: HostNic[] = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      if (NON_UPLINK_NIC_RE.test(name)) continue;
      const list = addrs ?? [];
      const v4 = list.find((a) => isIpv4Family(a.family) && !a.internal);
      const macAddr = list.find((a) => a.mac && a.mac !== '00:00:00:00:00:00')?.mac ?? '';
      const up = list.some((a) => !a.internal);
      const ipv4 = v4 ? (v4.cidr ?? v4.address) : null;
      nics.push({ name, mac: macAddr, ipv4, up });
    }
    return nics.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getConfig(): Promise<FleetConfig> {
    const doc = this.activeFleet();
    const d = doc.defaults;
    const zones = this.overlay.fleetZones();
    const firstZone = zones[0] ?? 'sim-zone';
    const cidr = doc.network.cidr ?? '';
    const bmcCidr = doc.network.bmc_cidr ?? '';
    const nodes: FleetNodeEffective[] = doc.nodes.map((n, index) => ({
      name: n.name,
      zone: typeof n.zone === 'string' && n.zone ? n.zone : firstZone,
      ipmi_mac: n.ipmi_mac,
      data_mac: n.data_mac,
      cpus: numOrNull(n.cpus),
      memory_mb: numOrNull(n.memory_mb),
      disk_gb: numOrNull(n.disk_gb),
      disks: n.disks ?? d.disks ?? [],
      passthrough: n.passthrough ?? d.passthrough ?? [],
      nics: (n.nics ?? []).map((nic) => ({
        mac: nic.mac,
        model: nicModel(nic.model),
        mtu: typeof nic.mtu === 'number' ? nic.mtu : null,
        link: nic.link === 'down' ? 'down' : 'up',
      })),
      data_mtu: n.data_mtu ?? null,
      arch: n.arch ?? null,
      network_type: n.network_type ?? null,
      ip: n.ip ?? null,
      bmc_ip: n.bmc_ip ?? null,
      bmc: n.bmc ? { username: n.bmc.username ?? '', password: maskBmcPassword(n.bmc.password) } : null,
      console_port: n.console_port ?? null,
      seed_as_server: typeof n.seed_as_server === 'boolean' ? n.seed_as_server : undefined,
      effective_ip: n.ip ? n.ip : ipAtOffset(cidr, NODE_IP_BASE + index) || null,
      effective_bmc_ip: n.bmc_ip ? n.bmc_ip : ipAtOffset(bmcCidr, NODE_IP_BASE + index) || null,
      effective_cpus: numOrNull(n.cpus) ?? numOrNull(d.cpus) ?? ENGINE_DEFAULTS.cpus,
      effective_memory_mb: numOrNull(n.memory_mb) ?? numOrNull(d.memory_mb) ?? ENGINE_DEFAULTS.memory_mb,
      effective_disk_gb: numOrNull(n.disk_gb) ?? numOrNull(d.disk_gb) ?? ENGINE_DEFAULTS.disk_gb,
    }));
    const dbmc = d.bmc;
    return {
      source: this.overlay.fleetCustomized() ? 'local' : 'default',
      mode: this.overlay.fleetMode(),
      baremetal: this.baremetalView(),
      bakedChainUrl: this.bakedChainUrl(),
      nodes,
      defaults: {
        cpus: numOrNull(d.cpus),
        memory_mb: numOrNull(d.memory_mb),
        disk_gb: numOrNull(d.disk_gb),
        arch: d.arch ?? null,
      },
      zones,
      network: networkView(doc.network),
      tombstones: this.overlay.fleetTombstones(),
      bmcDefaults: { username: dbmc?.username ?? 'admin', password: maskBmcPassword(dbmc?.password ?? 'admin') },
      pending: await this.pending(),
    };
  }

  private bmcCredsPath(): string | null {
    const state = process.env.DEVENV_STATE;
    return state ? join(state, 'baremetal', 'bmc-creds.json') : null;
  }

  private readBmcCreds(): BmcCredFile {
    const p = this.bmcCredsPath();
    if (!p || !existsSync(p)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'));
      if (raw === null || typeof raw !== 'object') return {};
      const out: BmcCredFile = {};
      for (const [name, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && 'user' in v && 'pass' in v) {
          const { user, pass } = v;
          if (typeof user === 'string' && typeof pass === 'string') out[name] = { user, pass };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeBmcCreds(updates: BmcCredFile, keep: Set<string>): void {
    const p = this.bmcCredsPath();
    if (!p) return;
    const cur = this.readBmcCreds();
    const keepAll = new Set(keep).add('defaults');
    const merged: BmcCredFile = {};
    for (const [name, cred] of Object.entries(cur)) if (keepAll.has(name)) merged[name] = cred;
    for (const [name, cred] of Object.entries(updates)) merged[name] = cred;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(merged, null, 2), { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  resolveBmcCred(nodeName: string): BmcCred | null {
    const creds = this.readBmcCreds();
    return creds[nodeName] ?? creds.defaults ?? null;
  }

  baremetalView(): BareMetalConfig {
    const bm = this.overlay.baremetalConfig();
    const arch: BareMetalConfig['arch'] = bm?.arch === 'arm64' ? 'arm64' : 'amd64';
    const idx = (spec: Record<string, unknown>): number => (typeof spec['index'] === 'number' ? spec['index'] : 0);
    const nodes: BareMetalNode[] = Object.entries(bm?.nodes ?? {})
      .sort(([, a], [, b]) => idx(a) - idx(b))
      .map(([name, spec]) => {
        const s: Record<string, unknown> = spec;
        const nodeArch = s.arch === 'amd64' || s.arch === 'arm64' ? s.arch : null;
        return {
          name,
          bmc_ip: typeof s.bmc_ip === 'string' ? s.bmc_ip : '',
          bmc_mac: typeof s.bmc_mac === 'string' ? s.bmc_mac : '',
          pxe_mac: typeof s.pxe_mac === 'string' ? s.pxe_mac : '',
          arch: nodeArch,
          system_id: typeof s.system_id === 'string' && s.system_id ? s.system_id : null,
        };
      });
    return { nics: bm?.nics ?? [], arch, nodes };
  }

  private bakedChainUrl(): string | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(ipxeBuildsDir(), '.chain-stamp.json'), 'utf8'));
      const stamp = ChainStampSchema.parse(raw);
      return typeof stamp.chain_base_url === 'string' ? stamp.chain_base_url : null;
    } catch {
      return null;
    }
  }

  /** 2s TTL so the Stack + Fleet 3s polls don't double-spawn python. `diff` exits 2 on drift —
   *  not an error — so stdout is read off the rejection too. */
  async pending(): Promise<FleetPending> {
    if (this.pendingCache && Date.now() - this.pendingCache.at < 2_000) return this.pendingCache.val;
    const gen = this.pendingGen;
    // Polls render to a sibling fleet.desired.yaml — never the staged fleet.yaml (mutating ops own
    // it). A null render degrades visibly rather than falling back to stale config.
    const source = await this.rendered.renderDesiredFleetYaml();
    if (!source) return this.degradedPending('fleet config refresh failed — see engine logs');
    const args = ['-m', 'local.fleet', 'diff', '--source', source];
    const withModeChange = (val: FleetPending): FleetPending =>
      this.modeChangePending() ? { ...val, inSync: false, severity: 'mode-change' } : val;
    const parse = (stdout: string): FleetPending => withModeChange(FleetPendingSchema.parse(JSON.parse(stdout)));
    const cache = (val: FleetPending): FleetPending => {
      if (this.pendingGen === gen) this.pendingCache = { at: Date.now(), val };
      return val;
    };
    try {
      const { stdout } = await execFileP('python', args, { cwd: this.runner.repoRoot, timeout: 30_000 });
      return cache(parse(stdout));
    } catch (e) {
      const stdout =
        e !== null && typeof e === 'object' && 'stdout' in e && typeof e.stdout === 'string' ? e.stdout : undefined;
      if (stdout) {
        try {
          return cache(parse(stdout));
        } catch (error) {
          this.log.debug(`fleet diff stdout parse failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Genuine failure — don't report in-sync, or the banner would silently hide real pending changes.
      this.log.warn('fleet diff failed — reporting drift as unavailable', e instanceof Error ? e.stack : String(e));
      return this.degradedPending('drift check failed — see engine logs');
    }
  }

  private appliedMode(): FleetMode {
    return readAppliedMode();
  }

  modeChangePending(): boolean {
    return this.overlay.fleetMode() !== this.appliedMode();
  }

  private degradedPending(note: string): FleetPending {
    return {
      inSync: false,
      severity: 'needs-full-rebuild',
      desiredDigest: '',
      appliedDigest: null,
      appliedAt: null,
      summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
      nodes: { added: [], removed: [], changed: [] },
      network: { changed: false, fields: [] },
      note,
    };
  }

  /** Call after any fleet mutation so an in-flight pending() won't write a stale result. */
  invalidatePending(): void {
    this.pendingCache = null;
    this.pendingGen++;
  }

  async applyPlan(): Promise<ApplyPlan> {
    const source = await this.rendered.renderDesiredFleetYaml();
    if (!source) throw new Error('could not refresh fleet config — cannot compute apply plan');
    const args = ['-m', 'local.fleet', 'apply', '--plan', '--source', source];
    const { stdout } = await execFileP('python', args, { cwd: this.runner.repoRoot, timeout: 30_000 });
    return ApplyPlanSchema.parse(JSON.parse(stdout));
  }

  /** getConfig hands out REDACTED, so a client echoing a bmc password back means "leave it". Without
   *  this the next save would store the mask itself and every BMC call would fail to authenticate. */
  private resolveBmcDefaults(
    submitted: { username: string; password: string } | undefined,
  ): { username: string; password: string } | undefined {
    if (!submitted || submitted.password !== REDACTED) return submitted;
    return { ...submitted, password: this.activeFleet().defaults.bmc?.password ?? '' };
  }

  private resolveNodeBmc(nodes: FleetNode[]): FleetNode[] {
    const stored = new Map(this.activeFleet().nodes.map((n) => [n.name, n.bmc?.password]));
    return nodes.map((n) => {
      if (n.bmc?.password !== REDACTED) return n;
      // No stored password means the mask names nothing, so leave the node as submitted: substituting
      // an empty string here would turn "I cannot resolve this" into "clear the credential".
      const kept = stored.get(n.name);
      return kept ? { ...n, bmc: { ...n.bmc, password: kept } } : n;
    });
  }

  /** `cmd_apply` prints the plan and returns before it checks the pinned fleet path and before it
   *  copies anything, so classifying a draft writes nothing but its own temp file. */
  async previewPlan(draft: {
    nodes: FleetNode[];
    defaults?: FleetDefaults;
    network?: FleetNetwork;
  }): Promise<ApplyPlan> {
    const source = await this.rendered.renderDesiredFleetYaml();
    if (!source)
      throw new ServiceUnavailableException('could not refresh the fleet config, so a draft cannot be classified');
    const specNodes = this.validateAndBuildVmSpecs(draft.nodes, 'vm');
    const parsed = RawFleetDocSchema.parse(yaml.load(readFileSync(source, 'utf8')) ?? {});
    const doc: Record<string, unknown> = { ...parsed };
    doc.nodes = specNodes.map(({ name, spec }) => ({ name, ...spec }));
    if (draft.network) doc.network = networkSpec(draft.network);
    if (draft.defaults) doc.defaults = draftDefaults(isRecord(parsed.defaults) ? parsed.defaults : {}, draft.defaults);
    // pid is constant and pendingGen only moves on a save, so two concurrent previews shared a path
    const tmp = join(mkdtempSync(join(tmpdir(), 'fleet-draft-')), 'fleet.yaml');
    try {
      writeFileSync(tmp, yaml.dump(doc));
      const { stdout } = await execFileP('python', ['-m', 'local.fleet', 'apply', '--plan', '--source', tmp], {
        cwd: this.runner.repoRoot,
        timeout: 30_000,
      });
      return ApplyPlanSchema.parse(JSON.parse(stdout));
    } finally {
      rmSync(dirname(tmp), { recursive: true, force: true });
    }
  }

  /** Validates, then persists via OverlayStoreService (the single overlay writer); bare-metal creds are
   *  split out to the 0600 secrets file, never the overlay. */
  putConfig(input: {
    mode: FleetMode;
    nodes: FleetNode[];
    bmcDefaults?: { username: string; password: string };
    defaults?: { cpus: number | null; memory_mb: number | null; disk_gb: number | null; arch: string | null };
    network?: FleetNetwork;
    prune?: string[];
    baremetal: BareMetalConfigWrite;
  }): RejectedEntry[] {
    const { mode, nodes, defaults, network, prune, baremetal } = input;
    const bmcDefaults = this.resolveBmcDefaults(input.bmcDefaults);
    const specNodes = this.validateAndBuildVmSpecs(this.resolveNodeBmc(nodes), mode);
    if (mode === 'baremetal') this.validateBaremetalNodes(baremetal);
    if (network) this.validateNetwork(network, nodes);
    if (prune?.length) this.validatePrune(prune);
    const bmSpec = this.buildBaremetalSpec(baremetal, mode);
    const rejected = this.overlay.setFleetConfig({
      nodes: specNodes,
      bmcDefaults,
      defaults,
      network: network ? networkSpec(network) : undefined,
      prune,
      mode,
      baremetal: { nics: baremetal.nics, arch: baremetal.arch, nodes: bmSpec.nodes },
    });
    // vm mode's bare-metal config is an unvalidated draft — keep every stored cred (clearing a
    // draft row must not purge its creds); baremetal mode purges to the request roster.
    const keepCreds =
      mode === 'baremetal' ? new Set(baremetal.nodes.map((n) => n.name)) : new Set(Object.keys(this.readBmcCreds()));
    this.writeBmcCreds(bmSpec.creds, keepCreds);
    this.invalidatePending();
    this.log.log(
      `saved fleet config to the stack overlay (mode=${mode}, ${nodes.length} vm nodes, ${baremetal.nodes.length} bare-metal nodes)`,
    );
    return rejected;
  }

  /** schema.py `_check_rendered_netplan` raises on both of these at engine load, minutes into an apply
   *  run. Refuse at the save instead, with the reason the engine gives. */
  private validateNetwork(net: FleetNetwork, nodes: FleetNode[]): void {
    if (!net.renderedNetplan) return;
    const zones = new Set(nodes.map((n) => n.zone).filter(Boolean));
    if (zones.size > 1)
      throw new BadRequestException(
        `rendered_netplan needs a single-zone fleet: ${zones.size} zones share one org and one cidr (${net.cidr}), so the hub cannot tell their primary prefixes apart and every device falls back to DHCP`,
      );
    if (net.dhcp)
      throw new BadRequestException(
        'rendered_netplan and dhcp are mutually exclusive: DHCP mode seeds the primary prefix for the DHCP server instead of a routable gateway, so the renderer emits the wildcard DHCP fallback rather than a rendered config',
      );
  }

  private validatePrune(prune: string[]): void {
    const known = new Map(this.overlay.fleetTombstones().map((t) => [t.name, t]));
    for (const name of prune) {
      const t = known.get(name);
      if (!t) throw new BadRequestException(`${name} is not a removed node, so there is no tombstone to drop`);
      if (t.baseDeclared)
        throw new BadRequestException(
          `${name} is still declared outside this overlay, so dropping its tombstone would bring the node back — disable it instead of removing it`,
        );
    }
  }

  private validateBaremetalNodes(bm: BareMetalConfigWrite): void {
    if (this.hostFacts().os !== 'linux') throw new BadRequestException('bare-metal mode requires a Linux host');
    if (bm.nics.length === 0) throw new BadRequestException('select an uplink NIC for bare-metal mode');
    if (bm.nodes.length === 0) throw new BadRequestException('add at least one bare-metal machine');
    const names = new Set<string>();
    const macs = new Set<string>();
    const ips = new Set<string>();
    for (const n of bm.nodes) {
      if (names.has(n.name)) throw new BadRequestException(`duplicate machine name: ${n.name}`);
      names.add(n.name);
      if (!isIpv4(n.bmc_ip)) throw new BadRequestException(`${n.name}: invalid BMC IPv4 ${n.bmc_ip}`);
      if (ips.has(n.bmc_ip)) throw new BadRequestException(`duplicate BMC IP: ${n.bmc_ip}`);
      ips.add(n.bmc_ip);
      for (const [label, mac] of [
        ['BMC MAC', n.bmc_mac],
        ['PXE MAC', n.pxe_mac],
      ] as const) {
        if (!isMac(mac)) throw new BadRequestException(`${n.name}: invalid ${label} ${mac}`);
        const norm = mac.toLowerCase();
        if (macs.has(norm)) throw new BadRequestException(`duplicate MAC: ${mac}`);
        macs.add(norm);
      }
      if ((n.bmc_user && !n.bmc_pass) || (!n.bmc_user && n.bmc_pass))
        throw new BadRequestException(`${n.name}: BMC username and password must both be set`);
    }
  }

  private buildBaremetalSpec(
    bm: BareMetalConfigWrite,
    mode: FleetMode,
  ): {
    nodes: { name: string; spec: Record<string, unknown> }[];
    creds: BmcCredFile;
  } {
    const nodes: { name: string; spec: Record<string, unknown> }[] = [];
    const creds: BmcCredFile = {};
    if (bm.bmcDefaults.username && bm.bmcDefaults.password)
      creds.defaults = { user: bm.bmcDefaults.username, pass: bm.bmcDefaults.password };
    for (const n of bm.nodes) {
      // vm mode persists the bare-metal draft unvalidated (validated on the flip to bare-metal),
      // so an empty-name draft row is skipped, not rejected.
      if (!n.name) {
        if (mode === 'baremetal') throw new BadRequestException('bare-metal machine name is required');
        continue;
      }
      // The reserved 'defaults' name is rejected in both modes — it would clobber the creds slot.
      if (n.name === 'defaults') throw new BadRequestException("machine name 'defaults' is reserved");
      const spec: Record<string, unknown> = {
        bmc_ip: n.bmc_ip,
        bmc_mac: n.bmc_mac.toLowerCase(),
        pxe_mac: n.pxe_mac.toLowerCase(),
      };
      if (n.arch) spec.arch = n.arch;
      if (n.system_id) spec.system_id = n.system_id;
      nodes.push({ name: n.name, spec });
      if (n.bmc_user && n.bmc_pass) creds[n.name] = { user: n.bmc_user, pass: n.bmc_pass };
    }
    return { nodes, creds };
  }

  private validateAndBuildVmSpecs(
    nodes: FleetNode[],
    mode: FleetMode,
  ): { name: string; spec: Record<string, unknown> }[] {
    if (mode === 'vm' && nodes.length === 0) throw new BadRequestException('fleet must have at least one node');
    const names = new Set<string>();
    const macs = new Set<string>();
    for (const n of nodes) {
      if (names.has(n.name)) throw new BadRequestException(`duplicate node name: ${n.name}`);
      names.add(n.name);
      if (n.ipmi_mac === n.data_mac) throw new BadRequestException(`${n.name}: ipmi_mac and data_mac must differ`);
      for (const mac of [n.ipmi_mac, n.data_mac, ...(n.nics ?? []).map((x) => x.mac)]) {
        if (macs.has(mac)) throw new BadRequestException(`duplicate mac: ${mac}`);
        macs.add(mac);
      }
    }
    const doc = this.activeFleet();
    const cidr = doc.network.cidr;
    const bmcCidr = doc.network.bmc_cidr;
    const checkIp = (name: string, ip: string, label: string, c?: string) => {
      if (!isIpv4(ip)) throw new BadRequestException(`${name}: invalid IPv4 ${ip}`);
      if (c) {
        if (!ipInCidr(ip, c)) throw new BadRequestException(`${name}: ${label} ${ip} is outside ${c}`);
        if (ipToInt(ip) === networkBase(c)! + 1)
          throw new BadRequestException(`${name}: ${label} ${ip} is the gateway`);
      }
    };
    const seenIps = new Set<string>();
    const seenBmc = new Set<string>();
    for (const n of nodes) {
      if (n.ip) {
        checkIp(n.name, n.ip, 'ip', cidr);
        if (seenIps.has(n.ip)) throw new BadRequestException(`duplicate ip: ${n.ip}`);
        seenIps.add(n.ip);
      }
      if (n.bmc_ip) {
        checkIp(n.name, n.bmc_ip, 'bmc_ip', bmcCidr);
        if (seenBmc.has(n.bmc_ip)) throw new BadRequestException(`duplicate bmc_ip: ${n.bmc_ip}`);
        seenBmc.add(n.bmc_ip);
      }
    }
    // Compare the EFFECTIVE port (override, else index-derived) — an explicit override must not
    // collide with another node's derived default either, matching the engine's loader.
    const seenConsole = new Map<number, string>();
    for (const [index, n] of nodes.entries()) {
      const port = n.console_port ?? CONSOLE_PORT_BASE + index;
      const other = seenConsole.get(port);
      if (other) throw new BadRequestException(`${n.name}: console_port ${port} collides with node ${other}`);
      seenConsole.set(port, n.name);
    }
    const seenPci = new Map<string, string>();
    for (const n of nodes) {
      for (const addr of n.passthrough ?? []) {
        const owner = seenPci.get(addr);
        if (owner)
          throw new BadRequestException(
            `PCI ${addr} assigned to both ${owner} and ${n.name} — passthrough is exclusive`,
          );
        seenPci.set(addr, n.name);
      }
    }
    const specNodes = nodes.map((n) => {
      const { name, nics, data_mtu, ip, bmc_ip, bmc, disks, passthrough, console_port, ...rest } = n;
      const { cpus, memory_mb, disk_gb, arch, network_type, ...flat } = rest;
      const spec: Record<string, unknown> = { ...flat };
      if (arch != null) spec.arch = arch;
      if (network_type != null) spec.network_type = network_type;
      if (cpus != null) spec.cpus = cpus;
      if (memory_mb != null) spec.memory_mb = memory_mb;
      if (disk_gb != null) spec.disk_gb = disk_gb;
      // slot 0 has no stamp and must keep deriving 9300 + index — never write a backfilled value
      if (console_port != null) spec.console_port = console_port;
      if (disks?.length) spec.disks = disks;
      if (passthrough?.length) spec.passthrough = passthrough;
      if (nics?.length) spec.nics = nics;
      if (data_mtu != null) spec.data_mtu = data_mtu;
      if (ip) spec.ip = ip;
      if (bmc_ip) spec.bmc_ip = bmc_ip;
      if (bmc?.username && bmc?.password) spec.bmc = bmc;
      return { name, spec };
    });
    return specNodes;
  }

  async addCommissioningNodesConfig(count = 2): Promise<{ added: string[]; existing: number }> {
    const cfg = await this.getConfig();
    const nodes = cfg.nodes;
    const existing = nodes.filter((n) => n.seed_as_server === false).length;
    const need = Math.max(0, count - existing);
    if (need === 0) return { added: [], existing };

    const usedOctets = new Set<number>();
    const GEN_PREFIX_RE = /^52:54:00:/i;
    for (const n of nodes) {
      for (const mac of [n.ipmi_mac, n.data_mac, ...n.nics.map((x) => x.mac)]) {
        if (!GEN_PREFIX_RE.test(mac)) continue;
        const last = parseInt(mac.split(':').pop() ?? '', 16);
        if (Number.isFinite(last)) usedOctets.add(last);
      }
    }
    const names = new Set(nodes.map((n) => n.name));
    const zone = nodes[0]?.zone ?? cfg.zones[0] ?? 'sim-zone';
    const added: FleetNode[] = [];
    let octet = 1;
    let nameN = 1;
    while (added.length < need) {
      while (usedOctets.has(octet)) octet++;
      if (octet > 254) throw new BadRequestException('no free MAC octet left for a new commissioning node');
      usedOctets.add(octet);
      let name = `onb-${nameN}`;
      while (names.has(name)) name = `onb-${++nameN}`;
      names.add(name);
      nameN++;
      const hex = octet.toString(16).padStart(2, '0');
      added.push({
        name,
        zone,
        ipmi_mac: `52:54:00:bc:00:${hex}`,
        data_mac: `52:54:00:da:00:${hex}`,
        arch: null,
        network_type: null,
        cpus: 2,
        memory_mb: 2048,
        disk_gb: 40,
        disks: [],
        passthrough: [],
        nics: [],
        data_mtu: null,
        ip: null,
        bmc_ip: null,
        bmc: null,
        seed_as_server: false,
      });
    }
    const baseNodes: FleetNode[] = nodes.map(
      ({ effective_ip, effective_bmc_ip, effective_cpus, effective_memory_mb, effective_disk_gb, ...rest }) => {
        void effective_ip;
        void effective_bmc_ip;
        void effective_cpus;
        void effective_memory_mb;
        void effective_disk_gb;
        return rest;
      },
    );
    this.putConfig({
      mode: cfg.mode,
      nodes: [...baseNodes, ...added],
      bmcDefaults: cfg.bmcDefaults,
      baremetal: {
        nics: cfg.baremetal.nics,
        arch: cfg.baremetal.arch,
        bmcDefaults: { username: '', password: '' },
        nodes: cfg.baremetal.nodes.map((n) => ({ ...n, bmc_user: null, bmc_pass: null })),
      },
    });
    this.log.log(`added ${added.length} commissioning node(s): ${added.map((n) => n.name).join(', ')}`);
    return { added: added.map((n) => n.name), existing };
  }

  dataIpForNode(name: string): string {
    const doc = this.activeFleet();
    const nodes = doc.nodes;
    const index = nodes.findIndex((n) => n.name === name);
    if (index < 0) throw new NotFoundException(`unknown node '${name}'`);
    const explicit = nodes[index].ip?.trim();
    if (explicit) return explicit;
    const cidr = doc.network.cidr;
    if (!cidr) throw new BadRequestException(`fleet config has no network.cidr — can't derive node IP for '${name}'`);
    if (parseCidr(cidr) === null) {
      throw new BadRequestException(`fleet config has malformed network.cidr '${cidr}'`);
    }
    return ipAtOffset(cidr, NODE_IP_BASE + index);
  }
}
