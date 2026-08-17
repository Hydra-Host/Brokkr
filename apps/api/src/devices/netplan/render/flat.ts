import type { DeviceContext } from '../../device-context/device-context.types';
import {
  buildEthernetsBlock,
  buildFallbackDhcpYaml,
  buildVlansBlock,
  hasEligibleConfiguredIp,
  renderBondBlock,
} from '../netplan-builders';
import {
  buildInterfacePlans,
  planHasDefaultRoute,
  prepareBondingDecision,
  synthesizeL3Routes,
  type RenderPlan,
} from '../netplan-planner';
import type { NetplanPhase } from '../netplan.service';
import { mapRoleToNetplanSlug } from './role-slug';

/**
 * FLAT-zone renderer.
 *
 * Falls through to the wildcard DHCP config when no eligible interface has an
 * IP, so the caller never has to pre-check addressability.
 */
export function renderFlat(ctx: DeviceContext, phase: NetplanPhase, onFallback?: (reason: string) => void): string {
  // Skip wt0 / IPMI / virtual interfaces. If none of the remaining
  // interfaces has any IPs, emit the wildcard DHCP fallback.
  if (!hasEligibleConfiguredIp(ctx.device.interfaces)) {
    return buildFallbackDhcpYaml();
  }

  const renderPlan = plan(ctx, phase);

  // Deliberate divergence from the upstream consolidated renderer, which drops
  // this check: a device with addresses but no resolvable gateway would emit a
  // static config that can reach nothing off-subnet. DHCP is the better guess,
  // and the fallback is loud so the missing Gateway row gets fixed.
  if (!planHasDefaultRoute(renderPlan)) {
    onFallback?.(
      `Device ${ctx.device.id} has eligible IPs but no default route or L3 static route; ` +
        `falling back to DHCP (phase: ${phase})`,
    );
    return buildFallbackDhcpYaml();
  }

  return emit(renderPlan);
}

/**
 * Build the in-memory rendering plan from the context: pick the device's
 * VRF, decide whether to bond, walk eligible interfaces, classify each IP
 * into either a non-VLAN configured interface or a VLAN group, and
 * synthesize L3 routes from sibling `l3-route` IPs.
 */
function plan(ctx: DeviceContext, phase: NetplanPhase): RenderPlan {
  const deviceRoleSlug = mapRoleToNetplanSlug(ctx.device.role);

  const interfacePlans = buildInterfacePlans(ctx, { deviceRoleSlug });
  const bond = prepareBondingDecision(interfacePlans);
  synthesizeL3Routes(ctx, interfacePlans);

  return { ctx, phase, bond, interfacePlans, deviceRoleSlug };
}

function emit({ ctx, phase, bond, interfacePlans }: RenderPlan): string {
  const lines: string[] = ['network:'];

  if (bond.shouldBond) {
    lines.push(...renderBondBlock(bond, interfacePlans));
  }

  lines.push(...buildEthernetsBlock(ctx, interfacePlans, bond));
  lines.push(...buildVlansBlock(ctx, interfacePlans, phase));

  lines.push('  version: 2');
  return lines.join('\n') + '\n';
}
