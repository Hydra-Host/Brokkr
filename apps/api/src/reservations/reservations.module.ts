import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { HostPluginGateBusModule } from '../plugin-host/host-plugin-gate-bus.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ReservationInvitesController } from './invites/reservation-invites.controller';
import { ReservationInvitesService } from './invites/reservation-invites.service';
import { ReservationProvisioningService } from './reservation-provisioning.service';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [PrismaModule, EmailModule, HostPluginGateBusModule],
  controllers: [ReservationInvitesController],
  providers: [ReservationsService, ReservationInvitesService, ReservationProvisioningService],
  exports: [ReservationsService, ReservationInvitesService, ReservationProvisioningService],
})
export class ReservationsModule {}
