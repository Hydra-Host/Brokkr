import { Injectable, NotFoundException } from '@nestjs/common';
import type { DhcpLease } from '@repo/api-client';
import { DhcpLeaseReaderService } from 'src/brokkr-bridge/dhcp/dhcp-lease-reader.service';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class DhcpLeasesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly leaseReader: DhcpLeaseReaderService,
  ) {}

  async getZoneDhcpLeases(zoneId: string): Promise<DhcpLease[]> {
    // Same permission as the per-prefix lease route this generalizes; the org-scoped
    // zone lookup below is what pins tenant scope (there is no prefix to restore()).
    this.contextService.requirePermission('ipam', 'read');

    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId, organizationId: this.contextService.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    return this.leaseReader.listLeasesForZone(zone.id);
  }

  async revokeZoneDhcpLease(zoneId: string, ip: string): Promise<DhcpLease> {
    this.contextService.requirePermission('ipam', 'update');

    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId, organizationId: this.contextService.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    const revoked = await this.leaseReader.revokeLease(zone.id, ip);
    if (!revoked) {
      throw new NotFoundException(`No DHCP lease held on ${ip}`);
    }
    return revoked;
  }
}
