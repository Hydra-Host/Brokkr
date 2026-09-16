import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { ContextService } from 'src/common/context/context.service';
import { DeviceTestRunsService } from 'src/device-test-runs/device-test-runs.service';
import { ReservationInvitesService } from 'src/reservations/invites/reservation-invites.service';
import { BaremetalService } from './baremetal.service';

@Controller()
export class BaremetalController {
  constructor(
    private readonly baremetalService: BaremetalService,
    private readonly reservationInvitesService: ReservationInvitesService,
    private readonly deviceTestRunsService: DeviceTestRunsService,
    private readonly contextService: ContextService,
  ) {}

  @TsRestHandler(contract.getServers)
  async getServers() {
    return tsRestHandler(contract.getServers, async ({ query }) => {
      const result = await this.baremetalService.getBaremetalServersPaginated(query);
      return { status: 200, body: result };
    });
  }

  @TsRestHandler(contract.getServerFilterOptions)
  async getServerFilterOptions() {
    return tsRestHandler(contract.getServerFilterOptions, async ({ query }) => {
      const identity = this.contextService.requireIdentity;
      const options = await this.baremetalService.getServerFilterOptions(identity.organizationId, query.role);
      return { status: 200, body: options };
    });
  }

  @TsRestHandler(contract.getServerTestRuns)
  async getServerTestRuns() {
    return tsRestHandler(contract.getServerTestRuns, async ({ query }) => {
      const { deviceId, type, status, ...paginationQuery } = query;
      const data = await this.deviceTestRunsService.findAllByOrganization(paginationQuery, {
        deviceId,
        type,
        status,
      });
      return { status: 200, body: data };
    });
  }

  @TsRestHandler(contract.getServerById)
  async getServerById() {
    return tsRestHandler(contract.getServerById, async ({ params }) => {
      const device = await this.baremetalService.getBaremetalServerById(params.deviceId);
      return { status: 200, body: device };
    });
  }

  @TsRestHandler(contract.getServerEcoMode)
  async getServerEcoMode() {
    return tsRestHandler(contract.getServerEcoMode, async ({ params }) => {
      const ecoMode = await this.baremetalService.getEcoModeStatus(params.deviceId);
      return { status: 200, body: ecoMode };
    });
  }

  @TsRestHandler(contract.commissionServer)
  async commissionServer() {
    return tsRestHandler(contract.commissionServer, async ({ body }) => {
      await this.baremetalService.commissionDiscoveredServer(body);
      return { status: 200, body: { success: true } };
    });
  }

  @TsRestHandler(contract.collectServerInventory)
  async collectServerInventory() {
    return tsRestHandler(contract.collectServerInventory, async ({ params }) => {
      const result = await this.baremetalService.collectInventory(params.deviceId);
      return { status: 200, body: result };
    });
  }

  @TsRestHandler(contract.updateServerListing)
  async updateServerListing() {
    return tsRestHandler(contract.updateServerListing, async ({ params, body }) => {
      const device = await this.baremetalService.updateListing(params.deviceId, body);
      return { status: 200, body: device };
    });
  }

  @TsRestHandler(contract.updateServerNickname)
  async updateServerNickname() {
    return tsRestHandler(contract.updateServerNickname, async ({ params, body }) => {
      const device = await this.baremetalService.updateNickname(params.deviceId, body.nickname);
      return { status: 200, body: device };
    });
  }

  @TsRestHandler(contract.updateServerInfo)
  async updateServerInfo() {
    return tsRestHandler(contract.updateServerInfo, async ({ params, body }) => {
      await this.baremetalService.updateServerInfo(params.deviceId, body);
      return { status: 200, body: { success: true } };
    });
  }

  @TsRestHandler(contract.decommissionServer)
  async decommissionServer() {
    return tsRestHandler(contract.decommissionServer, async ({ params }) => {
      const result = await this.baremetalService.updateServerToDecommissioned(params.deviceId);
      return { status: 200, body: result };
    });
  }

  // tombstone for the retired re-commission flow — see the contract note. No service call: there is
  // nothing left to do but tell the caller the path is gone.
  @TsRestHandler(contract.moveServerToDiscoveredHosts)
  async moveServerToDiscoveredHosts() {
    return tsRestHandler(contract.moveServerToDiscoveredHosts, async () => ({
      status: 410 as const,
      body: {
        statusCode: 410,
        error: 'Gone',
        message:
          'De-commissioning a server back to discovered-hosts status is no longer supported. Use PATCH /servers/:deviceId/decommission to remove a device from active inventory, or the commissioning flow to bring hardware back in.',
      },
    }));
  }

  @TsRestHandler(contract.provisionBaremetalServer)
  async provisionBaremetalServer() {
    return tsRestHandler(contract.provisionBaremetalServer, async ({ params, body }) => {
      const job = await this.baremetalService.provisionServer(params.deviceId, body);
      return { status: 200, body: { success: true, jobId: job.data.id } };
    });
  }

  @TsRestHandler(contract.getReservationInvitesByServer)
  async getReservationInvitesByServer() {
    return tsRestHandler(contract.getReservationInvitesByServer, async ({ params, query }) => {
      const paginated = await this.reservationInvitesService.fetchAllReservationInvitesByDeviceIdForSupplier(
        params.deviceId,
        query,
      );
      return { status: 200, body: paginated };
    });
  }

  @TsRestHandler(contract.createReservationInvite)
  async createReservationInvite() {
    return tsRestHandler(contract.createReservationInvite, async ({ body }) => {
      const invite = await this.reservationInvitesService.createReservationInviteAsASupplyCustomer(body);
      return { status: 201 as const, body: invite };
    });
  }

  @TsRestHandler(contract.editReservationInvite)
  async editReservationInvite() {
    return tsRestHandler(contract.editReservationInvite, async ({ params, body }) => {
      const invite = await this.reservationInvitesService.editReservationInviteAsASupplyCustomer(params.inviteId, body);
      return { status: 200 as const, body: invite };
    });
  }

  @TsRestHandler(contract.deleteReservationInvite)
  async deleteReservationInvite() {
    return tsRestHandler(contract.deleteReservationInvite, async ({ params }) => {
      await this.reservationInvitesService.deleteReservationInviteAsASupplyCustomer(params.inviteId);
      return { status: 204 as const, body: undefined };
    });
  }
}
