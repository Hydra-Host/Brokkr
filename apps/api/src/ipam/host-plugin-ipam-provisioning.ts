import type {
  PluginCreateIpAddressInput,
  PluginCreateIpRangeInput,
  PluginCreatePrefixInput,
  PluginCreatedIpAddress,
  PluginCreatedIpRange,
  PluginCreatedPrefix,
  PluginIpamProvisioning,
  PluginIpamRollbackInput,
  PluginSetPrefixGatewayInput,
} from '@hydrahost/plugin-sdk';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import { ContextService } from 'src/common/context/context.service';
import { EventLogService } from 'src/event-log/event-log.service';
import { IpAddressService } from './ip-address/ip-address.service';
import { IpRangeService } from './ip-range/ip-range.service';
import { IpamRoleRepository } from './ipam-role/ipam-role.repository';
import { PrefixService } from './prefix/prefix.service';

/** Host binding for `PLUGIN_IPAM_PROVISIONING` — runs each write under `runAsSystem(organizationId)`. */
@Injectable()
export class HostPluginIpamProvisioning implements PluginIpamProvisioning {
  constructor(
    private readonly contextService: ContextService,
    private readonly prefixService: PrefixService,
    private readonly ipAddressService: IpAddressService,
    private readonly ipRangeService: IpRangeService,
    private readonly ipamRoleRepository: IpamRoleRepository,
    private readonly eventLog: EventLogService,
  ) {}

  async createPrefix(input: PluginCreatePrefixInput): Promise<PluginCreatedPrefix> {
    return this.asOrg(input.organizationId, async () => {
      const prefixRoleId = await this.resolvePrefixRoleId(input.prefixRoleSlug);
      const created = await this.prefixService.createPrefix({
        prefix: input.prefix,
        role: input.role,
        zoneId: input.zoneId,
        prefixRoleId,
        status: 'ACTIVE',
      });
      return { id: created.id, prefix: created.prefix };
    });
  }

  async createIpAddress(input: PluginCreateIpAddressInput): Promise<PluginCreatedIpAddress> {
    return this.asOrg(input.organizationId, async () => {
      const created = await this.ipAddressService.createIpAddress({
        address: input.address,
        status: 'ACTIVE',
      });
      return { id: created.id, address: created.address };
    });
  }

  async setPrefixGateway(input: PluginSetPrefixGatewayInput): Promise<void> {
    await this.asOrg(input.organizationId, async () => {
      await this.prefixService.setPrefixGateway(input.prefixId, input.gatewayIpId);
    });
  }

  async createIpRange(input: PluginCreateIpRangeInput): Promise<PluginCreatedIpRange> {
    return this.asOrg(input.organizationId, async () => {
      const created = await this.ipRangeService.createIpRange({
        prefixId: input.prefixId,
        start: input.start,
        end: input.end,
        purpose: input.purpose,
        status: 'ACTIVE',
      });
      return { id: created.id, start: created.start, end: created.end };
    });
  }

  async rollbackProvisioned(input: PluginIpamRollbackInput): Promise<void> {
    await this.asOrg(input.organizationId, async () => {
      const now = new Date();
      // One transaction across three models plus the event row: a rollback that removed records but
      // left no trace is the case an auditor cannot recover from, so the row shares their fate.
      await ActiveRecordRegistry.transaction(async (tx) => {
        const ipRanges =
          input.ipRangeIds.length > 0
            ? await tx.ipRange.updateMany({
                where: {
                  id: { in: input.ipRangeIds },
                  organizationId: input.organizationId,
                  deletedAt: null,
                },
                data: { deletedAt: now },
              })
            : { count: 0 };
        const prefixes =
          input.prefixIds.length > 0
            ? await tx.prefix.updateMany({
                where: {
                  id: { in: input.prefixIds },
                  organizationId: input.organizationId,
                  deletedAt: null,
                },
                data: { gatewayIpId: null, deletedAt: now },
              })
            : { count: 0 };
        const ipAddresses =
          input.ipAddressIds.length > 0
            ? await tx.ipAddress.updateMany({
                where: {
                  id: { in: input.ipAddressIds },
                  organizationId: input.organizationId,
                  deletedAt: null,
                },
                data: { deletedAt: now },
              })
            : { count: 0 };

        await this.eventLog.recordInTransaction(tx, {
          organizationId: input.organizationId,
          tier: 'EVIDENCE',
          durability: 'ATOMIC',
          resource: 'ipam',
          action: 'rollback',
          actionKey: 'ipam.rollback',
          // Pinned rather than resolved: `asOrg` enters runAsSystem, so the plugin host is the only
          // possible actor here, and the audit criterion is specifically about SYSTEM attribution.
          actorType: 'SYSTEM',
          actorId: null,
          actorLabel: null,
          ...this.contextService.requestFields(),
          outcome: 'SUCCEEDED',
          requestId: this.contextService.requestId ?? null,
          // Affected counts, not requested counts: the gap is the drift an auditor needs to see.
          metadata: {
            prefixes: prefixes.count,
            ipAddresses: ipAddresses.count,
            ipRanges: ipRanges.count,
          },
        });
      });
    });
  }

  private async resolvePrefixRoleId(slug: 'primary' | 'management'): Promise<string> {
    const roles = await this.ipamRoleRepository.list();
    const match = roles.find((role) => role.slug === slug);
    if (!match) {
      throw new NotFoundException(`IpamPrefixVlanRole with slug "${slug}" not found`);
    }
    return match.id;
  }

  private asOrg<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
    if (!organizationId) {
      throw new BadRequestException('organizationId is required for IPAM provisioning');
    }
    return this.contextService.runAsSystem(organizationId, fn);
  }
}
