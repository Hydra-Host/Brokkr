import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { CommissioningService } from './commissioning.service';

@Controller()
export class CommissioningController {
  constructor(private readonly commissioningService: CommissioningService) {}

  @TsRestHandler(contract.scanZoneManagementSubnets)
  async scanZoneManagementSubnets() {
    return tsRestHandler(contract.scanZoneManagementSubnets, async ({ params, body }) => {
      const result = await this.commissioningService.scanZoneManagementSubnets(params.zoneId, body.subnets);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.listZoneManagementSubnets)
  async listZoneManagementSubnets() {
    return tsRestHandler(contract.listZoneManagementSubnets, async ({ params }) => {
      const result = await this.commissioningService.listManagementSubnets(params.zoneId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.pollCommissioningScan)
  async pollCommissioningScan() {
    return tsRestHandler(contract.pollCommissioningScan, async ({ params }) => {
      const result = await this.commissioningService.pollScanSession(params.zoneId, params.sessionId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.enrichCommissioningDevice)
  async enrichCommissioningDevice() {
    return tsRestHandler(contract.enrichCommissioningDevice, async ({ params, body }) => {
      const result = await this.commissioningService.enrichDevice(params.zoneId, body);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.pollCommissioningEnrichment)
  async pollCommissioningEnrichment() {
    return tsRestHandler(contract.pollCommissioningEnrichment, async ({ params }) => {
      const result = await this.commissioningService.pollEnrichmentStatus(params.zoneId, params.planId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.cancelCommissioningEnrichment)
  async cancelCommissioningEnrichment() {
    return tsRestHandler(contract.cancelCommissioningEnrichment, async ({ params }) => {
      const result = await this.commissioningService.cancelEnrichment(params.zoneId, params.planId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.refreshCommissioningEnrichment)
  async refreshCommissioningEnrichment() {
    return tsRestHandler(contract.refreshCommissioningEnrichment, async ({ params, body }) => {
      const devices = await this.commissioningService.refreshEnrichment(params.zoneId, body.devices);
      return { status: 200 as const, body: { devices } };
    });
  }

  @TsRestHandler(contract.validateCommissioning)
  async validateCommissioning() {
    return tsRestHandler(contract.validateCommissioning, async ({ params, body }) => {
      const result = await this.commissioningService.validateCommissioning(params.zoneId, body.devices);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.commissionDevices)
  async commissionDevices() {
    return tsRestHandler(contract.commissionDevices, async ({ params, body }) => {
      const result = await this.commissioningService.commissionDevices(params.zoneId, body.devices);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.getCommissioningProgress)
  async getCommissioningProgress() {
    return tsRestHandler(contract.getCommissioningProgress, async ({ params }) => {
      const result = await this.commissioningService.getCommissioningProgress(params.zoneId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.acknowledgeCommissioning)
  async acknowledgeCommissioning() {
    return tsRestHandler(contract.acknowledgeCommissioning, async ({ params }) => {
      const result = await this.commissioningService.acknowledgeCommissioning(params.zoneId, params.deviceId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.retryCommissioning)
  async retryCommissioning() {
    return tsRestHandler(contract.retryCommissioning, async ({ params, body }) => {
      const result = await this.commissioningService.retryCommissioning(params.zoneId, params.deviceId, body.device);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.retryCommissioningStep)
  async retryCommissioningStep() {
    return tsRestHandler(contract.retryCommissioningStep, async ({ params }) => {
      const result = await this.commissioningService.retryCommissioningStep(params.zoneId, params.deviceId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.cancelCommissioning)
  async cancelCommissioning() {
    return tsRestHandler(contract.cancelCommissioning, async ({ params }) => {
      const result = await this.commissioningService.cancelCommissioning(params.zoneId, params.deviceId);
      return { status: 200 as const, body: result };
    });
  }
}
