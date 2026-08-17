/** One entry point: derives a device's render family from role + zone and dispatches to `render/`.
 * Invariants that look like cleanup opportunities but are not, plus gotchas: ./README.md */
import { NetplanPopulation as PrismaNetplanPopulation, ZoneEastWestNetworkType, ZoneNetworkType } from '@repo/database';
import type { DeviceContext } from '../device-context/device-context.types';
import { isIpv4, pickPrefixForIp } from './netplan-planner';
import type { NetplanPhase } from './netplan.service';
import { renderBridgeBonded } from './render/bridge-bonded';
import { renderBridgeDefault } from './render/bridge-default';
import { renderBridgeSansVrf } from './render/bridge-sans-vrf';
import { renderFlat } from './render/flat';
import { roleGetsBridge } from './render/role-slug';
import { renderVpc } from './render/vpc';

// Re-exported from the service so the entry point is self-contained; the type-only import erases
// the service <-> dispatcher cycle. redis-keys.ts keeps its own copy (see README).
export type { NetplanPhase };

export interface NetplanRenderOptions {
  phase: NetplanPhase;
  /** Called when a family degrades to the wildcard DHCP config instead of failing. */
  onFallback?: (reason: string) => void;
  /** Called when `Device.netplanPopulation` overrode the derived family. */
  onPin?: (reason: string) => void;
}

export type NetplanPopulation = 'flat' | 'vpc' | 'vpc-roce' | 'bridge-default' | 'bridge-bonded' | 'bridge-sans-vrf';

export function renderNetplanYaml(ctx: DeviceContext, opts: NetplanRenderOptions): string {
  assertIpamResolvable(ctx);

  const pinned = ctx.device.netplanPopulation;
  if (pinned) {
    // Surfaced so a pinned device rendering an unexpected family reads as the deliberate
    // override it is, not a renderer bug.
    opts.onPin?.(
      `Device ${ctx.device.id} renders as ${PINNED_POPULATION[pinned]} from an explicit ` +
        `netplanPopulation pin, not the derived family`,
    );
  }

  switch (derivePopulation(ctx)) {
    case 'bridge-bonded':
      return renderBridgeBonded(ctx);
    case 'bridge-sans-vrf':
      return renderBridgeSansVrf(ctx);
    case 'bridge-default':
      return renderBridgeDefault(ctx);
    case 'vpc-roce':
      return renderVpc(ctx, opts.phase, { offset: 4, roce: true });
    case 'vpc':
      return renderVpc(ctx, opts.phase, { offset: 6, roce: false });
    case 'flat':
      return renderFlat(ctx, opts.phase, opts.onFallback);
  }
}

/** IPv4 addresses with zero prefixes (usually a null `supplierId`) would render interfaces with no
 * address, route or nameserver — a silently networkless device. Fail instead. */
function assertIpamResolvable(ctx: DeviceContext): void {
  if (ctx.ipam.prefixes.length > 0 || ctx.ipam.vrfPrefixes.length > 0) return;

  const addresses = ctx.device.interfaces.flatMap((iface) =>
    iface.ipAddresses.filter((ip) => isIpv4(ip.address)).map((ip) => ip.address),
  );
  if (addresses.length === 0) return;

  throw new Error(
    `Device ${ctx.device.id} has ${addresses.length} IPv4 address(es) (${addresses.join(', ')}) but no IPAM prefixes ` +
      `resolved, so every address would be dropped and the device would boot with no network. ` +
      `Check that the device has a supplier organization set — IPAM is scoped by it.`,
  );
}

/** An exception list, not per-device tracking: null means "derive". Exists because ~8% of the
 * upstream fleet made an operator family choice that role+zone cannot recover. */
const PINNED_POPULATION: Record<PrismaNetplanPopulation, NetplanPopulation> = {
  [PrismaNetplanPopulation.FLAT]: 'flat',
  [PrismaNetplanPopulation.VPC]: 'vpc',
  [PrismaNetplanPopulation.VPC_ROCE]: 'vpc-roce',
  [PrismaNetplanPopulation.BRIDGE_DEFAULT]: 'bridge-default',
  [PrismaNetplanPopulation.BRIDGE_BONDED]: 'bridge-bonded',
  [PrismaNetplanPopulation.BRIDGE_SANS_VRF]: 'bridge-sans-vrf',
};

/** Role + zone are authoritative; the bridge variant is a heuristic (bond prefix -> bonded, no VRF
 * -> sans-vrf, else default). Pin via `netplanPopulation` when it guesses wrong. */
export function derivePopulation(ctx: DeviceContext): NetplanPopulation {
  // An explicit pin wins. It exists because the derivation below provably
  // cannot express the whole fleet — see `PINNED_POPULATION`.
  const pinned = ctx.device.netplanPopulation;
  if (pinned) return PINNED_POPULATION[pinned];

  if (roleGetsBridge(ctx.device.role)) {
    if (bridgeHasBondPrefix(ctx)) return 'bridge-bonded';
    if (!bridgeHasVrf(ctx)) return 'bridge-sans-vrf';
    return 'bridge-default';
  }

  if (ctx.device.zone?.networkType === ZoneNetworkType.VPC) {
    return ctx.device.zone.eastWestNetworkType === ZoneEastWestNetworkType.ROCE ? 'vpc-roce' : 'vpc';
  }

  return 'flat';
}

function bridgeHasBondPrefix(ctx: DeviceContext): boolean {
  return someResolvedPrefix(ctx, (prefix) => {
    const params = prefix.bondParameters;
    return params !== null && typeof params === 'object' && !Array.isArray(params);
  });
}

function bridgeHasVrf(ctx: DeviceContext): boolean {
  for (const iface of ctx.device.interfaces) {
    for (const ip of iface.ipAddresses) {
      if (!isIpv4(ip.address)) continue;
      if (ip.vrfId) return true;
    }
  }
  return someResolvedPrefix(ctx, (prefix) => prefix.vrfId !== null);
}

function someResolvedPrefix(
  ctx: DeviceContext,
  predicate: (prefix: NonNullable<ReturnType<typeof pickPrefixForIp>>) => boolean,
): boolean {
  for (const iface of ctx.device.interfaces) {
    for (const ip of iface.ipAddresses) {
      if (!isIpv4(ip.address)) continue;
      const prefix = pickPrefixForIp(ctx, ip, ip.vrfId ?? null);
      if (prefix && predicate(prefix)) return true;
    }
  }
  return false;
}
