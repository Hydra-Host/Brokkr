import { HttpModule } from '@nestjs/axios';
import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BrokkrBridgeModule } from 'src/brokkr-bridge/brokkr-bridge.module';
import { DhcpConfigModule } from 'src/brokkr-bridge/dhcp/dhcp-config.module';
import { CloudInitTemplatesModule } from 'src/cloud-init-templates/cloud-init-templates.module';
import { DeviceSecretModule } from 'src/device-secret/device-secret.module';
import { DeviceTestRunsModule } from 'src/device-test-runs/device-test-runs.module';
import { DeviceTokensModule } from 'src/device-tokens/device-tokens.module';
import { EmailModule } from 'src/email/email.module';
import { InventoryModule } from 'src/inventory/inventory.module';
import { LifecycleModule } from 'src/lifecycle/lifecycle.module';
import { OrganizationsModule } from 'src/organizations/organizations.module';
import { PrismaModule } from 'src/prisma/prisma.module';
import { ProvisionModule } from 'src/provision/provision.module';
import { ReservationsModule } from 'src/reservations/reservations.module';
import { UsersModule } from 'src/users/users.module';
import { BaremetalController } from './baremetal.controller';
import { BaremetalService } from './baremetal.service';
import { DeviceContextModule } from './device-context/device-context.module';
import { DeviceNotificationsRepository } from './device-notifications/device-notifications.repository';
import { DeviceNotificationsService } from './device-notifications/device-notifications.service';
import { NetplanModule } from './netplan/netplan.module';

@Module({
  imports: [
    PrismaModule,
    HttpModule,
    ConfigModule,
    forwardRef(() => InventoryModule),
    forwardRef(() => ProvisionModule),
    forwardRef(() => LifecycleModule),
    UsersModule,
    ReservationsModule,
    DeviceTestRunsModule,
    forwardRef(() => OrganizationsModule),
    forwardRef(() => BrokkrBridgeModule),
    DhcpConfigModule,
    CloudInitTemplatesModule,
    DeviceContextModule,
    NetplanModule,
    EmailModule,
    DeviceSecretModule,
    DeviceTokensModule,
  ],
  controllers: [BaremetalController],
  providers: [DeviceNotificationsService, DeviceNotificationsRepository, BaremetalService],
  exports: [DeviceNotificationsService, BaremetalService, DeviceContextModule, NetplanModule],
})
export class DevicesModule {}
