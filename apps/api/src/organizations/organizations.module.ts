import { forwardRef, Module } from '@nestjs/common';
import { AuthClientModule } from 'src/auth/auth-client.module';
import { DeploymentsModule } from 'src/deployments/deployments.module';
import { WebhookModule } from 'src/webhook/webhook.module';
import { EmailModule } from '../email/email.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OrganizationApiKeysController } from './api-keys/organization-api-keys.controller';
import { OrganizationApiKeysService } from './api-keys/organization-api-keys.service';
import { OrganizationInvitationsController } from './invitations/organization-invitations.controller';
import { OrganizationInvitationsRepository } from './invitations/organization-invitations.repository';
import { OrganizationInvitationsService } from './invitations/organization-invitations.service';
import { OrganizationMembershipsController } from './members/organization-members.controller';
import { OrganizationMembershipsRepository } from './members/organization-members.repository';
import { OrganizationMembershipsService } from './members/organization-members.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';
import { ORGANIZATIONS_SERVICE } from './organizations.tokens';
import { OrganizationWebhooksController } from './webhooks/organization-webhooks.controller';
import { OrganizationWebhooksService } from './webhooks/organization-webhooks.service';

@Module({
  imports: [PrismaModule, EmailModule, forwardRef(() => DeploymentsModule), WebhookModule, AuthClientModule],
  controllers: [
    OrganizationMembershipsController,
    OrganizationInvitationsController,
    OrganizationApiKeysController,
    OrganizationWebhooksController,
    OrganizationsController,
  ],
  providers: [
    OrganizationsService,
    {
      provide: ORGANIZATIONS_SERVICE,
      useExisting: OrganizationsService,
    },
    OrganizationsRepository,
    OrganizationMembershipsService,
    OrganizationMembershipsRepository,
    OrganizationApiKeysService,
    OrganizationInvitationsService,
    OrganizationInvitationsRepository,
    OrganizationWebhooksService,
  ],
  exports: [
    OrganizationsService,
    ORGANIZATIONS_SERVICE,
    OrganizationMembershipsService,
    OrganizationInvitationsService,
    OrganizationWebhooksService,
  ],
})
export class OrganizationsModule {}
