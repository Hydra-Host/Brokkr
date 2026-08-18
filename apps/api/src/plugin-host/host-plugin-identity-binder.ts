import { type PluginIdentityBinder, type PluginVerifiedApiKey } from '@hydrahost/plugin-sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RbacResolverService } from '@repo/auth/rbac';

import { buildApiKeyIdentityContext } from '../auth/api-key-identity';
import { AuthRepository } from '../auth/auth.repo';
import { ContextService } from '../common/context/context.service';
import { PrismaClient } from '../prisma/prisma.client';

@Injectable()
export class HostPluginIdentityBinder implements PluginIdentityBinder {
  private readonly logger = new Logger(HostPluginIdentityBinder.name);

  constructor(
    private readonly contextService: ContextService,
    @Inject(AuthRepository) private readonly repo: Pick<AuthRepository, 'findOrganizationMember'>,
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(RbacResolverService)
    private readonly rbacResolver: Pick<RbacResolverService, 'resolveEffectivePermissions'>,
  ) {}

  async bindVerifiedApiKey(key: PluginVerifiedApiKey): Promise<void> {
    this.contextService.identity = Object.freeze(
      await buildApiKeyIdentityContext(key, {
        prisma: this.prisma,
        repo: this.repo,
        rbacResolver: this.rbacResolver,
        logger: this.logger,
      }),
    );
  }
}
