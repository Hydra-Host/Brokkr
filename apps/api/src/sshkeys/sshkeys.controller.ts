import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { SshKeysService } from './sshkeys.service';

@Controller()
export class SshkeysController {
  constructor(private readonly sshkeysService: SshKeysService) {}

  @TsRestHandler(contract.getSshKeys)
  async getSshKeys() {
    return tsRestHandler(contract.getSshKeys, async ({ query }) => {
      const paginated = await this.sshkeysService.getSshKeysByUserId(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @TsRestHandler(contract.getOrganizationSshKeys)
  async getSshKeysForOrganization() {
    return tsRestHandler(contract.getOrganizationSshKeys, async ({ query }) => {
      const paginated = await this.sshkeysService.getSshKeysByOrganizationId(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @TsRestHandler(contract.getSshKey)
  async getSshKey() {
    return tsRestHandler(contract.getSshKey, async ({ params }) => {
      const key = await this.sshkeysService.getSshKeyById(params.id);
      return { status: 200 as const, body: key };
    });
  }

  @TsRestHandler(contract.createSshKey)
  async createSshKey() {
    return tsRestHandler(contract.createSshKey, async ({ body }) => {
      const key = await this.sshkeysService.createSshKey(body);
      return { status: 201 as const, body: key };
    });
  }

  @TsRestHandler(contract.deleteSshKey)
  async deleteSshKey() {
    return tsRestHandler(contract.deleteSshKey, async ({ params }) => {
      const key = await this.sshkeysService.deleteSshKey(params.id);
      return { status: 200 as const, body: key };
    });
  }
}
