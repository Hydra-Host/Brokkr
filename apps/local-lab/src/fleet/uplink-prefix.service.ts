import { Inject, Injectable } from '@nestjs/common';

import { PrefixDhcpConfigSchema, type PrefixDhcpConfig } from '@repo/api-client';
import { canonicalMac, getErrorMessage } from '@repo/utils';
import { hubApiFetch, hubApiSignIn } from '../common/hub-client';
import { URLS } from '../ports';
import type { RunState } from '../runner/runner.service';
import { OverlayStoreService } from '../services/overlay-store';
import { zoneUuid } from '../zones/zones.service';
import { FleetPowerService } from './fleet-power.service';
import {
  containingPrefix,
  dhcpConfigPath,
  HubPrefixListSchema,
  HubPrefixSchema,
  networkCidr,
  PREFIXES_PATH,
  prefixPath,
  type HubPrefix,
} from './hub-prefix';
import { simNetworkCidrs } from './sim-network';

type Emit = (text: string) => void;
type HubAnswer = { code: number; body: unknown };
type HubCall = (method: string, path: string, body?: unknown) => Promise<HubAnswer>;

type Step<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Step<T> => ({ ok: true, value });
const fail = <T>(reason: string): Step<T> => ({ ok: false, reason });

const canonicalMacs = (macs: string[]): string[] =>
  [...new Set(macs.map((m) => canonicalMac(m) ?? m.trim().toLowerCase()))].sort();

const NOT_SIM = 'the uplink NIC must sit on a real LAN, not the sim network';

const describeAnswer = (answer: HubAnswer): string => `${answer.code} ${JSON.stringify(answer.body)}`;

const fmt = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

@Injectable()
export class UplinkPrefixService {
  constructor(
    @Inject(OverlayStoreService)
    private readonly overlay: Pick<OverlayStoreService, 'bmUplink' | 'fleetZones' | 'fleetConfig'>,
    @Inject(FleetPowerService) private readonly fleet: Pick<FleetPowerService, 'roster'>,
  ) {}

  /** Exit 0 means the containing prefix is converged, whether or not this run wrote anything. */
  async configure(run: RunState, emit: Emit): Promise<number> {
    const say = (text: string): void => emit(`[uplink-prefix] ${text}\n`);
    const refuse = (text: string): number => {
      say(text);
      return 1;
    };

    const uplink = this.overlay.bmUplink();
    if (uplink === null)
      return refuse('no bare-metal uplink: save a machine and pick an uplink NIC that holds an IPv4 address first');
    const zones = this.overlay.fleetZones();
    if (zones.length === 0) return refuse('no zone is declared, so there is no zone to put the prefix in');
    const zoneId = zoneUuid(0);

    // refuse before the hub is dialed: resolvePrefix would otherwise create a prefix for a sim-range NIC
    const candidate = uplink.cidr === null ? null : networkCidr(uplink.cidr);
    if (candidate !== null && this.isSimNetwork(candidate))
      return refuse(
        `the uplink IP ${uplink.ip} (${uplink.iface}) sits in the simulator's own ${candidate} — ${NOT_SIM}`,
      );

    const hubBase = URLS.dial.hubApi;
    let jar: Map<string, string>;
    try {
      jar = await hubApiSignIn(hubBase);
    } catch (error) {
      return refuse(`hub sign-in failed: ${getErrorMessage(error)}`);
    }
    const hub: HubCall = (method, path, body) => hubApiFetch(hubBase, jar, method, path, body);

    const found = await this.resolvePrefix(run, hub, uplink, zones[0], zoneId, say);
    if (!found.ok) return refuse(found.reason);
    let hit = found.value;

    if (this.isSimNetwork(hit.prefix))
      return refuse(
        `the prefix containing the uplink IP ${uplink.ip} is the simulator's own ${hit.prefix} — ${NOT_SIM}`,
      );

    if (hit.zoneId == null) {
      const patched = await hub('PATCH', prefixPath(hit.id), { zoneId });
      const parsed = patched.code === 200 ? HubPrefixSchema.safeParse(patched.body) : null;
      if (!parsed?.success)
        return refuse(`assigning ${hit.prefix} to zone ${zones[0]} failed: ${describeAnswer(patched)}`);
      say(`${hit.prefix} zoneId: null → ${zoneId} (${zones[0]})`);
      hit = parsed.data;
    }

    const current = await hub('GET', dhcpConfigPath(hit.id));
    const read = current.code === 200 ? PrefixDhcpConfigSchema.safeParse(current.body) : null;
    if (!read?.success) return refuse(`reading the DHCP config of ${hit.prefix} failed: ${describeAnswer(current)}`);

    // the hub keeps MACs as typed, so a case- or order-only difference must not read as a change
    const before: PrefixDhcpConfig = {
      ...read.data,
      dhcpProxyAllowedMacs: canonicalMacs(read.data.dhcpProxyAllowedMacs),
    };
    const after = this.desired(before);
    const changed = Object.keys(after).filter(
      (key): key is keyof PrefixDhcpConfig => JSON.stringify(after[key]) !== JSON.stringify(before[key]),
    );
    if (changed.length === 0) {
      say(
        `nothing to change: ${hit.prefix} is PROXY / SNPONLY with the authoritative peer declared and ${after.dhcpProxyAllowedMacs.length} MAC(s) allowed`,
      );
      return 0;
    }
    if (run.cancelled) return refuse('canceled before the DHCP config was written');

    const put = await hub('PUT', dhcpConfigPath(hit.id), after);
    const written = put.code === 200 ? PrefixDhcpConfigSchema.safeParse(put.body) : null;
    if (!written?.success) return refuse(`writing the DHCP config of ${hit.prefix} failed: ${describeAnswer(put)}`);
    say(`${hit.prefix} configured for the bare-metal uplink ${uplink.iface} (${uplink.ip}):`);
    for (const key of changed) emit(`  ${key}: ${fmt(before[key])} → ${fmt(written.data[key])}\n`);
    return 0;
  }

  private async resolvePrefix(
    run: RunState,
    hub: HubCall,
    uplink: NonNullable<ReturnType<OverlayStoreService['bmUplink']>>,
    zone: string,
    zoneId: string,
    say: Emit,
  ): Promise<Step<HubPrefix>> {
    const listed = await this.listPrefixes(hub);
    if (!listed.ok) return listed;
    const hit = containingPrefix(listed.value, uplink.ip);
    if (hit !== null) return ok(hit);

    if (uplink.cidr === null)
      return fail(
        `no hub prefix contains ${uplink.ip} and ${uplink.iface} reports no netmask, so the network to create is unknown — create the prefix containing ${uplink.ip} under IPAM → Prefixes by hand`,
      );
    const network = networkCidr(uplink.cidr);
    if (network === null) return fail(`the uplink cidr ${uplink.cidr} is not a usable IPv4 network`);
    if (run.cancelled) return fail('canceled before the prefix was created');

    say(`no hub prefix contains the uplink IP ${uplink.ip} (${uplink.iface}) — creating ${network} in zone ${zone}`);
    const created = await hub('POST', PREFIXES_PATH, { prefix: network, zoneId, status: 'ACTIVE' });
    if (created.code === 201) {
      const parsed = HubPrefixSchema.safeParse(created.body);
      return parsed.success ? ok(parsed.data) : fail(`the created prefix did not parse: ${describeAnswer(created)}`);
    }
    // a 409 means the prefix appeared between the list and the create, so it is the one to configure
    if (created.code !== 409) return fail(`creating ${network} failed: ${describeAnswer(created)}`);
    const relisted = await this.listPrefixes(hub);
    if (!relisted.ok) return relisted;
    const raced = containingPrefix(relisted.value, uplink.ip);
    return raced !== null
      ? ok(raced)
      : fail(`creating ${network} answered 409 but no hub prefix contains ${uplink.ip}: ${describeAnswer(created)}`);
  }

  private async listPrefixes(hub: HubCall): Promise<Step<HubPrefix[]>> {
    const list = await hub('GET', PREFIXES_PATH);
    const parsed = list.code === 200 ? HubPrefixListSchema.safeParse(list.body) : null;
    return parsed?.success ? ok(parsed.data) : fail(`listing the hub prefixes failed: ${describeAnswer(list)}`);
  }

  private desired(before: PrefixDhcpConfig): PrefixDhcpConfig {
    const rosterMacs = this.fleet.roster().flatMap((n) => (n.kind === 'baremetal' && n.pxeMac ? [n.pxeMac] : []));
    return {
      ...before,
      dhcpMode: 'PROXY',
      ipxeBuildTarget: 'SNPONLY',
      dhcpProxyPeerAuthoritative: true,
      dhcpProxyAllowedMacs: canonicalMacs([...before.dhcpProxyAllowedMacs, ...rosterMacs]),
    };
  }

  private isSimNetwork(cidr: string): boolean {
    const network = networkCidr(cidr) ?? cidr;
    return simNetworkCidrs(this.overlay.fleetConfig()).some((sim) => (networkCidr(sim) ?? sim) === network);
  }
}
