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
      const prisma = ActiveRecordRegistry.client;
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        if (input.ipRangeIds.length > 0) {
          await tx.ipRange.updateMany({
            where: {
              id: { in: input.ipRangeIds },
              organizationId: input.organizationId,
              deletedAt: null,
            },
            data: { deletedAt: now },
          });
        }
        if (input.prefixIds.length > 0) {
          await tx.prefix.updateMany({
            where: {
              id: { in: input.prefixIds },
              organizationId: input.organizationId,
              deletedAt: null,
            },
            data: { gatewayIpId: null, deletedAt: now },
          });
        }
        if (input.ipAddressIds.length > 0) {
          await tx.ipAddress.updateMany({
            where: {
              id: { in: input.ipAddressIds },
              organizationId: input.organizationId,
              deletedAt: null,
            },
            data: { deletedAt: now },
          });
        }
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
