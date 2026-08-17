import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { ReservationInvitesService } from './reservation-invites.service';

@Controller()
export class ReservationInvitesController {
  constructor(private readonly reservationInvitesService: ReservationInvitesService) {}

  @TsRestHandler(contract.getReservationInvite)
  async getReservationInvite() {
    return tsRestHandler(contract.getReservationInvite, async ({ params }) => {
      const invite = await this.reservationInvitesService.fetchReservationInviteForUser(params.id);
      return { status: 200 as const, body: invite };
    });
  }

  @TsRestHandler(contract.getReservationInvites)
  async getReservationInvites() {
    return tsRestHandler(contract.getReservationInvites, async ({ query }) => {
      const paginated = await this.reservationInvitesService.fetchAllReservationInvitesForUser(query);
      return { status: 200 as const, body: paginated };
    });
  }
}
