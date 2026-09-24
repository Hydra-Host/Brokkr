import { Inject, Injectable } from '@nestjs/common';
import type { PrefixBootReadiness, PrefixBootReadinessQuery } from '@repo/api-client';
import { prefixBootFindings } from '@repo/device-domain';
import { ContextService } from 'src/common/context/context.service';
import { PrefixRepository } from './prefix.repository';

export { HUB_BOOT_CHECKS } from '@repo/device-domain';

@Injectable()
export class PrefixBootReadinessService {
  constructor(
    @Inject(PrefixRepository)
    private readonly prefixRepository: Pick<
      PrefixRepository,
      'getDhcpConfig' | 'getProxyAllowlist' | 'resolveBootIdentity'
    >,
    @Inject(ContextService) private readonly contextService: Pick<ContextService, 'requirePermission'>,
  ) {}

  async check(prefixId: string, query: PrefixBootReadinessQuery): Promise<PrefixBootReadiness> {
    this.contextService.requirePermission('ipam', 'read');
    // getDhcpConfig pins the tenant scope and 404s a prefix this organization cannot see.
    const config = await this.prefixRepository.getDhcpConfig(prefixId);
    const allowlist = await this.prefixRepository.getProxyAllowlist(prefixId);
    const identity =
      query.bmcAddress === undefined
        ? null
        : await this.prefixRepository.resolveBootIdentity(query.mac, query.bmcAddress);
    return { findings: prefixBootFindings(config, identity, query, allowlist) };
  }
}
