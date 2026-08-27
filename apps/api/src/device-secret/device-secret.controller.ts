import { Controller, Header, UseGuards } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { InstanceOperatorGuard } from 'src/auth/guards/instance-operator.guard';
import { DeviceSecretAccessService } from './device-secret-access.service';

@Controller()
@UseGuards(InstanceOperatorGuard)
export class DeviceSecretController {
  constructor(private readonly access: DeviceSecretAccessService) {}

  @TsRestHandler(contract.listDeviceSecretVersions)
  async listDeviceSecretVersions() {
    return tsRestHandler(contract.listDeviceSecretVersions, async ({ params }) => {
      const result = await this.access.listVersions(params.deviceId);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.listDeviceSecretAuditEvents)
  async listDeviceSecretAuditEvents() {
    return tsRestHandler(contract.listDeviceSecretAuditEvents, async ({ params, query }) => {
      const result = await this.access.listAuditEvents(params.deviceId, query);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.writeDeviceSecret)
  async writeDeviceSecret() {
    return tsRestHandler(contract.writeDeviceSecret, async ({ params, body }) => {
      const result = await this.access.write(params.deviceId, body);
      return { status: 201 as const, body: result };
    });
  }

  @TsRestHandler(contract.requestDeviceSecretReveal)
  async requestDeviceSecretReveal() {
    return tsRestHandler(contract.requestDeviceSecretReveal, async ({ params }) => {
      const result = await this.access.requestReveal(params.deviceId, params.purpose, params.version);
      return { status: 202 as const, body: result };
    });
  }

  @TsRestHandler(contract.getDeviceSecretRevealStatus)
  @Header('Cache-Control', 'private, no-store, no-cache, must-revalidate')
  @Header('Pragma', 'no-cache')
  @Header('Expires', '0')
  async getDeviceSecretRevealStatus() {
    return tsRestHandler(contract.getDeviceSecretRevealStatus, async ({ params }) => {
      const result = await this.access.getRevealStatus(params.deviceId, params.requestId);
      return { status: 200 as const, body: result };
    });
  }
}
