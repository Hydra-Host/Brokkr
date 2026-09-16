import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import { probe } from '../common/probe';
import type { BridgeHttpStatus, ZoneAgentWork, ZoneBridges, ZoneCrypto, ZoneRuntime, ZoneVrrp } from '../contract';
import { ZoneRegistryService } from '../datastore/zone-registry.service';
import { OverlayStoreService } from '../services/overlay-store';
import { AgentWorkReaderService } from './agent-work.reader';
import { buildBridgeInventory, type ConfiguredBridge } from './bridge-inventory';
import { BridgeStatusReader } from './bridge-status.reader';
import { LeaderReaderService } from './leader.reader';
import { deriveDesiredHolder, scopeHoldersToZone } from './vrrp-desired';
import { VrrpReaderService } from './vrrp.reader';
import { ZoneCryptoReaderService } from './zone-crypto.reader';

const unknownVrrp = (readError: string): ZoneVrrp => ({ observability: 'unavailable', vips: [], readError });
const unknownCrypto = (readError: string): ZoneCrypto => ({
  state: 'unknown',
  bootstrapLockTtlSeconds: null,
  readError,
});
const unknownAgentWork = (readError: string): ZoneAgentWork => ({
  dispatchesInFlight: null,
  lastActivityAtMs: null,
  scanCapped: null,
  readError,
});

const zoneBridgeIds = (bridges: ZoneBridges): Set<string> | null =>
  bridges.readError === null ? new Set(bridges.rows.map((bridge) => bridge.instanceId)) : null;

@Injectable()
export class ZoneRuntimeService {
  private readonly log = new Logger(ZoneRuntimeService.name);

  constructor(
    private readonly zoneRegistry: ZoneRegistryService,
    private readonly overlay: OverlayStoreService,
    private readonly leaderReader: LeaderReaderService,
    private readonly vrrpReader: VrrpReaderService,
    private readonly cryptoReader: ZoneCryptoReaderService,
    private readonly agentWorkReader: AgentWorkReaderService,
    private readonly bridgeStatusReader: BridgeStatusReader,
  ) {}

  async list(): Promise<ZoneRuntime[]> {
    const zones = await this.zoneRegistry.listLiveZones();
    return Promise.all(zones.map((zone) => this.forZone(zone.id, zone.name)));
  }

  private async forZone(zoneId: string, zoneName: string | null): Promise<ZoneRuntime> {
    try {
      const configured = this.configuredBridges(zoneName);
      const [leader, presence, vrrp, zoneCrypto, agentWork, http] = await Promise.all([
        this.leaderReader.leader(zoneId),
        this.probeSection(zoneId, 'presence', () => this.leaderReader.presence(zoneId)),
        this.probeSection(zoneId, 'vrrp', () => this.vrrpReader.read(zoneId)),
        this.probeSection(zoneId, 'zone crypto', () => this.cryptoReader.read(zoneId)),
        this.probeSection(zoneId, 'agent work', () => this.agentWorkReader.read(zoneId)),
        this.bridgeHttp(configured),
      ]);

      const bridges: ZoneBridges =
        presence === null
          ? { rows: [], readError: 'bridge presence read failed' }
          : { rows: buildBridgeInventory(presence, configured, Date.now(), http), readError: null };

      return {
        zoneId,
        zoneName,
        leader,
        bridges,
        vrrp: this.withZoneScope(vrrp, leader.holder, zoneBridgeIds(bridges)),
        zoneCrypto: zoneCrypto ?? unknownCrypto('zone crypto probe failed'),
        agentWork: agentWork ?? unknownAgentWork('agent work read failed'),
        readError: null,
      };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`zone runtime assembly failed for ${zoneId}: ${readError}`);
      return {
        zoneId,
        zoneName,
        leader: { holder: null, ttlSeconds: null, readError },
        bridges: { rows: [], readError },
        vrrp: unknownVrrp(readError),
        zoneCrypto: unknownCrypto(readError),
        agentWork: unknownAgentWork(readError),
        readError,
      };
    }
  }

  private withZoneScope(
    vrrp: ZoneVrrp | null,
    leaderHolder: string | null,
    zoneBridgeIds: Set<string> | null,
  ): ZoneVrrp {
    if (vrrp === null) return unknownVrrp('vrrp read failed');
    return {
      ...vrrp,
      vips: vrrp.vips.map((vip) => ({
        ...vip,
        desiredHolder: vip.atomError === null ? deriveDesiredHolder(leaderHolder, vip.ifaceByBridge) : null,
        observedHolders: scopeHoldersToZone(vip.observedHolders, zoneBridgeIds),
      })),
    };
  }

  private configuredBridges(zoneName: string | null): ConfiguredBridge[] {
    return this.overlay
      .labBridges()
      .filter((bridge) => zoneName !== null && bridge.zone === zoneName)
      .map((bridge) => ({ instanceId: bridge.proc, port: bridge.port, grpcPort: bridge.grpc }));
  }

  private async bridgeHttp(configured: ConfiguredBridge[]): Promise<Map<string, BridgeHttpStatus | null>> {
    const entries = await Promise.all(
      configured.map(
        async (bridge): Promise<[string, BridgeHttpStatus | null]> => [
          bridge.instanceId,
          await this.bridgeStatusReader.read(bridge.port),
        ],
      ),
    );
    return new Map(entries);
  }

  private probeSection<T>(zoneId: string, label: string, read: () => Promise<T>): Promise<T | null> {
    return probe(read, (message) => this.log.debug(`${label} read failed for ${zoneId}: ${message}`));
  }
}
