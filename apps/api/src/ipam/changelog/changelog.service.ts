import { Injectable } from '@nestjs/common';
import { IpamChangelogEntry, IpamChangelogQuery } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { IpamChangelogRepository } from './changelog.repository';

@Injectable()
export class IpamChangelogService {
  constructor(
    private readonly contextService: ContextService,
    private readonly changelogRepository: IpamChangelogRepository,
  ) {}

  async listIpamChangelog(query: IpamChangelogQuery): Promise<IpamChangelogEntry[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.changelogRepository.listIpamChangelog(query, this.contextService.organizationId);
  }
}
