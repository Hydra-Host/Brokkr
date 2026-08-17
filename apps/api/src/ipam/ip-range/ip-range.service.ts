import { Injectable } from '@nestjs/common';
import {
  CreateIpRangeRequest,
  DetectIpRangeOverlapRequest,
  IpRange,
  IpRangeListQuery,
  IpRangeOverlapResult,
  UpdateIpRangeRequest,
} from '@repo/api-client';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { ContextService } from 'src/common/context/context.service';
import { IpRangeEntity } from './ip-range.entity';
import { IpRangeRepository } from './ip-range.repository';

@Injectable()
export class IpRangeService {
  constructor(
    private readonly iprangeRepository: IpRangeRepository,
    private readonly contextService: ContextService,
    private readonly dhcpPublisher: DhcpConfigPublisherService,
  ) {}

  async findById(id: string): Promise<IpRange> {
    this.contextService.requirePermission('ipam', 'read');
    return this.iprangeRepository.restore(id);
  }

  async listIpRanges(query: IpRangeListQuery): Promise<IpRange[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.iprangeRepository.listIpRanges(query);
  }

  async createIpRange(input: CreateIpRangeRequest): Promise<IpRange> {
    this.contextService.requirePermission('ipam', 'create');
    const prefix = await this.iprangeRepository.loadPrefix(input.prefixId);
    const scopedVrfId = input.vrfId !== undefined ? input.vrfId : prefix.vrfId;
    const entity = IpRangeEntity.create(input, this.contextService.organizationId, scopedVrfId ?? null);
    await this.iprangeRepository.normalizeBounds(entity);
    await this.iprangeRepository.ensureVersionMatch(entity.state.start, entity.state.end);
    await this.iprangeRepository.ensureScope(prefix, entity.state.vrfId);
    await this.iprangeRepository.ensureBounds(prefix, entity.state.start, entity.state.end);
    await this.iprangeRepository.ensureNoOverlap(entity, null);
    const created = await this.iprangeRepository.save(entity);
    // A pool is a DHCP atom input — republish the owning prefix eagerly (cron is the backstop).
    await this.dhcpPublisher.republishPrefixes([created.prefixId]);
    return created;
  }

  async updateIpRange(id: string, input: UpdateIpRangeRequest): Promise<IpRange> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.iprangeRepository.restore(id);
    const entity = IpRangeEntity.restore(before);
    entity.applyUpdate(input);

    if (entity.shouldValidatePlacement) {
      const prefix = await this.iprangeRepository.loadPrefix(entity.state.prefixId);
      if (entity.shouldNormalizeBounds) {
        await this.iprangeRepository.normalizeBounds(entity);
      }
      await this.iprangeRepository.ensureVersionMatch(entity.state.start, entity.state.end);
      await this.iprangeRepository.ensureScope(prefix, entity.state.vrfId);
      await this.iprangeRepository.ensureBounds(prefix, entity.state.start, entity.state.end);
      await this.iprangeRepository.ensureNoOverlap(entity, id);
    }

    const updated = await this.iprangeRepository.save(entity);
    // An update never moves a range between prefixes, so before/after share one prefix — republish it once.
    await this.dhcpPublisher.republishPrefixes([updated.prefixId]);
    return updated;
  }

  async archiveIpRange(id: string): Promise<IpRange> {
    this.contextService.requirePermission('ipam', 'delete');
    const before = await this.iprangeRepository.restore(id);
    const entity = IpRangeEntity.restore(before);
    entity.archive();
    const archived = await this.iprangeRepository.save(entity);
    await this.dhcpPublisher.republishPrefixes([archived.prefixId]);
    return archived;
  }

  async detectIpRangeOverlap(input: DetectIpRangeOverlapRequest): Promise<IpRangeOverlapResult> {
    return this.iprangeRepository.detectIpRangeOverlap(input);
  }
}
