/**
 * Smoke e2e — fast, non-destructive checks that the local-dev stack is up.
 *
 * Branches on fleet.mode: the vm group checks the sim fleet, the baremetal group checks the bench
 * box's BMC + proxy DHCP. Roster access happens inside each `it` — a describe-factory deref crashes
 * collection on a bm roster.
 */
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  effectiveBmcIp,
  effectiveNodeIp,
  loadFleet,
  simDeviceUuid,
  type BareMetal,
  type BareMetalNode,
  type FleetNode,
} from './helpers';
import { HubDB } from './hub-db';
import { OS_SLUG, step } from './lifecycle-helpers';
import { VMClient } from './vm-client';

const HUB_URL = process.env.SIM_HUB_URL ?? 'http://127.0.0.1:3000';
const BRIDGE_URL = process.env.SIM_BRIDGE_URL ?? 'http://127.0.0.1:8000';
const IPXE_BUILDS_DIR = process.env.LOCAL_IPXE_BUILDS_DIR ?? '/opt/brokkr/ipxe-builds';
const PXE_PROXY_PORT = 4011;

const fleet = loadFleet();
const execFileP = promisify(execFile);
const SIM_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const chainStampSchema = z.object({ chain_base_url: z.string() });

const spokeStatusSchema = z.object({
  dhcp_standby_health: z
    .object({ is_leader: z.boolean(), hydrated: z.boolean(), answering: z.boolean() })
    .nullable()
    .optional(),
});

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let hubDb: HubDB;

beforeAll(() => {
  hubDb = HubDB.fromEnv();
  step(`smoke: fleet mode ${fleet.mode}`, { metadata: { mode: fleet.mode } });
});

afterAll(async () => {
  await hubDb.prisma.$disconnect();
});

function bareMetal(): BareMetal {
  const bm = fleet.baremetal;
  if (!bm) {
    throw new Error(
      `fleet.yaml (${process.env.LOCAL_FLEET_PATH}) is mode=baremetal but carries no baremetal block — ` +
        're-apply the fleet from the control center Fleet builder',
    );
  }
  return bm;
}

function bmNode(): BareMetalNode {
  const nodes = bareMetal().nodes;
  const node = nodes[0];
  if (!node) {
    throw new Error(
      'fleet.yaml baremetal.nodes is empty — add the bench machine in the control center Fleet builder and Apply',
    );
  }
  return node;
}

async function udpPortHeld(port: number): Promise<boolean> {
  return new Promise<boolean>((done, fail) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: false });
    const close = () => {
      try {
        sock.close();
      } catch {
        void 0;
      }
    };
    sock.once('error', (err: NodeJS.ErrnoException) => {
      close();
      // Only EADDRINUSE means held; EACCES and friends would otherwise read as "free".
      if (err.code === 'EADDRINUSE') done(true);
      else fail(err);
    });
    sock.once('listening', () => {
      close();
      done(false);
    });
    sock.bind(port, '0.0.0.0');
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('smoke', () => {
  it('hub listens on its API port', async () => {
    const response = await fetch(`${HUB_URL}/healthcheck`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.ok).toBe(true);
  });

  it('spoke listens on its HTTP port', async () => {
    const response = await fetch(`${BRIDGE_URL}/api/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(200);
  });

  describe.runIf(fleet.mode === 'vm')('vm fleet', () => {
    it('fleet has nodes', () => {
      expect(fleet.nodes.length).toBeGreaterThanOrEqual(1);
    });

    it('device rows exist in hub postgres', async () => {
      const n = fleet.nodes.length;
      const bmcIps = fleet.nodes.map((node, i) => effectiveBmcIp(node, fleet.network.bmc_cidr, i));

      const devices = await hubDb.getDeviceIdsByBmcIps(bmcIps);

      expect(devices).toHaveLength(n);

      const foundIds = new Set(devices.map((d: { id: string }) => d.id));
      for (let i = 0; i < n; i++) {
        const expected = simDeviceUuid(i);
        expect(foundIds.has(expected)).toBe(true);
      }
    });

    describe('agent active on each VM', () => {
      fleet.nodes.forEach((node: FleetNode, index: number) => {
        it(`${node.name} has brokkr-bridge-agent.service active`, async (ctx) => {
          const ip = effectiveNodeIp(node, fleet.network.cidr, index);
          const vm = new VMClient(ip);
          let active: boolean;
          try {
            active = await vm.systemctlActive('brokkr-bridge-agent.service');
          } catch {
            ctx.skip();
            return;
          }
          expect(active).toBe(true);
        });
      });
    });

    it('spoke /api/chain responds with iPXE script', async () => {
      const params = new URLSearchParams({
        mac: fleet.nodes[0]!.data_mac,
        buildarch: 'arm64',
      });

      const response = await fetch(`${BRIDGE_URL}/api/chain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      });

      const body = await response.text();
      expect(body.startsWith('#!ipxe')).toBe(true);
    });

    describe('BMC control plane reachable', () => {
      it('first node IPMI chassis power status responds (ipmi_sim)', async () => {
        const { stdout } = await execFileP('bash', ['scripts/tasks/ipmi.sh', fleet.nodes[0]!.name, 'power', 'status'], {
          cwd: SIM_DIR,
          timeout: 30_000,
        });
        expect(stdout).toMatch(/Chassis Power is (on|off)/i);
      });
      it('first node Redfish reports a power state (sushy)', async () => {
        const { stdout } = await execFileP('bash', ['scripts/tasks/redfish.sh', fleet.nodes[0]!.name, 'status'], {
          cwd: SIM_DIR,
          timeout: 30_000,
        });
        expect(stdout).toMatch(/"?(On|Off)"?/);
      });
    });
  });

  describe.runIf(fleet.mode === 'baremetal')('bare-metal bench box', () => {
    it('fleet.yaml carries a bare-metal roster', () => {
      const bm = bareMetal();
      expect(bm.nodes.length).toBeGreaterThanOrEqual(1);
      step(`bare-metal roster: ${bm.nodes.map((n) => n.name).join(', ')} on ${bm.iface} (${bm.iface_ip})`);
    });

    it('the BMC IP resolves to a hub Device row', async () => {
      const node = bmNode();
      const devices = await hubDb.getDeviceIdsByBmcIps([node.bmc_ip]);
      expect(
        devices.length,
        `no hub Device has an IPMI IpAddress of ${node.bmc_ip} — re-seed the bare-metal identity ` +
          '(`task sim:bm:reconcile` then the bare-metal seed) so the box exists in the hub',
      ).toBeGreaterThanOrEqual(1);
    });

    it('the PXE MAC resolves to the same Device row as the BMC IP', async () => {
      const node = bmNode();
      const [byBmc] = await hubDb.getDeviceIdsByBmcIps([node.bmc_ip]);
      const byMac = await hubDb.getDeviceIdByMac(node.pxe_mac);
      step(
        `bare-metal identity: ${node.pxe_mac} -> ${byMac ?? 'null'} (bmc ${node.bmc_ip} -> ${byBmc?.id ?? 'null'})`,
        {
          metadata: { pxeMac: node.pxe_mac, deviceIdByMac: byMac, deviceIdByBmc: byBmc?.id ?? null },
        },
      );
      expect(
        byMac,
        `no hub Interface carries the declared PXE MAC ${node.pxe_mac} — either the wrong 1G NIC is ` +
          'cabled/declared in the fleet overlay, or the identity seed drifted',
      ).not.toBeNull();
      expect(
        byMac,
        `${node.pxe_mac} and BMC ${node.bmc_ip} resolve to DIFFERENT hub Devices — fix the fleet ` +
          'overlay pxe_mac or re-seed so one Device owns both',
      ).toBe(byBmc?.id ?? null);
    });

    it('the BMC answers a read-only Redfish power-state probe', async () => {
      const node = bmNode();
      const byMac = await hubDb.getDeviceIdByMac(node.pxe_mac);
      expect(byMac, `cannot probe the BMC without a Device id for ${node.pxe_mac}`).not.toBeNull();
      const { stdout, stderr } = await execFileP('python', ['-m', 'local.bm_power', node.pxe_mac, byMac!, '--status'], {
        cwd: SIM_DIR,
        env: process.env,
        timeout: 120_000,
      });
      const out = `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, '');
      step(`bare-metal BMC probe: ${out.trim().split('\n').at(-1) ?? ''}`);
      expect(
        out,
        `bm_power --status printed no PowerState for ${node.name} — the BMC at ${node.bmc_ip} is ` +
          'unreachable or its sealed credentials are stale (re-seal with `task up`)',
      ).toMatch(/PowerState=\w+/);
    });

    it('iPXE build assets exist and chain back to the spoke on the bench uplink', () => {
      const bm = bareMetal();
      const archDir = join(IPXE_BUILDS_DIR, bm.arch);
      const binaries = ['snponly.efi', 'snp.efi', 'ipxe.efi'].filter((f) => existsSync(join(archDir, f)));
      expect(
        binaries,
        `no iPXE EFI binary under ${archDir} — run the control center's iPXE build (or \`task up\`) ` +
          'so the proxy-DHCP bootfile exists',
      ).not.toHaveLength(0);

      const stampPath = join(IPXE_BUILDS_DIR, '.chain-stamp.json');
      expect(existsSync(stampPath), `${stampPath} missing — the iPXE build never completed`).toBe(true);
      const stamp = chainStampSchema.parse(JSON.parse(readFileSync(stampPath, 'utf8')));
      expect(
        new URL(stamp.chain_base_url).hostname,
        `the iPXE binaries chain to ${stamp.chain_base_url}, which is not the bench uplink IP ` +
          `${bm.iface_ip} — rebuild iPXE after the fleet change so the box can reach /api/chain`,
      ).toBe(bm.iface_ip);
      step(`iPXE assets: ${binaries.join(', ')} in ${archDir}, chain base ${stamp.chain_base_url}`);
    });

    it('the uplink prefix is configured for proxy DHCP with the PXE MAC allowed', async () => {
      const bm = bareMetal();
      const node = bmNode();
      const policy = await hubDb.getDhcpPolicyForIp(bm.iface_ip);
      expect(
        policy,
        `no hub Prefix contains the bench uplink IP ${bm.iface_ip} — create it under IPAM -> Prefixes ` +
          'in the hub SPA before proxy DHCP can be configured',
      ).not.toBeNull();

      const missing: string[] = [];
      if (policy!.dhcpMode !== 'PROXY') missing.push(`dhcpMode is ${policy!.dhcpMode ?? 'null'}, want PROXY`);
      if (!policy!.ipxeBuildTarget)
        missing.push('ipxeBuildTarget is null, want SNPONLY (without it the PROXY ACK carries no bootfile)');
      if (!policy!.dhcpProxyAllowedMacs.some((m) => m.toLowerCase() === node.pxe_mac.toLowerCase()))
        missing.push(`dhcpProxyAllowedMacs does not contain ${node.pxe_mac}`);

      step(
        `uplink prefix ${policy!.prefix}: dhcpMode=${policy!.dhcpMode ?? 'null'} ` +
          `ipxeBuildTarget=${policy!.ipxeBuildTarget ?? 'null'} allowedMacs=[${policy!.dhcpProxyAllowedMacs.join(', ')}]`,
      );
      expect(
        missing,
        `prefix ${policy!.prefix} (${policy!.id}) will not answer a PXE DISCOVER: ${missing.join('; ')}. ` +
          "Set all three in the hub SPA's prefix DHCP config card " +
          `(PUT /api/v1/ipam/prefixes/${policy!.id}/dhcp/config) — the harness never writes them.`,
      ).toEqual([]);
    });

    it('the spoke reports it is answering DHCP', async () => {
      const response = await fetch(`${BRIDGE_URL}/api/status`, { signal: AbortSignal.timeout(5_000) });
      const status = spokeStatusSchema.parse(await response.json());
      expect(
        status.dhcp_standby_health,
        'the spoke published no dhcp_standby_health — its DHCP engine was never built, which means no ' +
          'prefix atom reached it (set the uplink prefix to dhcpMode=PROXY in the hub SPA)',
      ).toBeTruthy();
      expect(
        status.dhcp_standby_health?.answering,
        `spoke DHCP is not answering (is_leader=${status.dhcp_standby_health?.is_leader}, ` +
          `hydrated=${status.dhcp_standby_health?.hydrated}) — a non-leader or unhydrated spoke serves nothing`,
      ).toBe(true);
    });

    it('the spoke holds the proxy-DHCP boot-service socket', async () => {
      const held = await udpPortHeld(PXE_PROXY_PORT);
      expect(
        held,
        `udp/${PXE_PROXY_PORT} is free, so nothing on this host is serving the proxy-DHCP boot service — ` +
          'the spoke logged a bind failure (it swallows them) or is not running with cap_net_bind_service',
      ).toBe(true);
    });

    it('the lifecycle base OS has an artifact in the effective layer build', async () => {
      const bm = bareMetal();
      const node = bmNode();
      const deviceId = await hubDb.getDeviceIdByMac(node.pxe_mac);
      expect(deviceId, `cannot resolve the effective layer build without a Device for ${node.pxe_mac}`).not.toBeNull();
      const present = await hubDb.hasBaseArtifact(OS_SLUG, bm.arch, deviceId!);
      step(`base OS precondition: ${OS_SLUG}/${bm.arch} artifact present=${present}`, {
        metadata: { osSlug: OS_SLUG, arch: bm.arch },
      });
      expect(
        present,
        `no READY LayerArtifact for base '${OS_SLUG}' on ${bm.arch} in the device's effective layer ` +
          'build — re-run the OS-catalog seed, or pick a base the build carries (provision would 400 later)',
      ).toBe(true);
    });

    it('spoke /api/chain renders an iPXE script for the PXE MAC', async () => {
      const bm = bareMetal();
      const node = bmNode();
      const params = new URLSearchParams({ mac: node.pxe_mac, buildarch: bm.arch });
      const response = await fetch(`${BRIDGE_URL}/api/chain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      expect(
        body.startsWith('#!ipxe'),
        `/api/chain returned no iPXE script for ${node.pxe_mac} (status ${response.status}): ` +
          `${body.slice(0, 200)}`,
      ).toBe(true);
    });
  });
});
