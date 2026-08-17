import { Controller, Req } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Request } from 'express';
import { OrganizationApiKeysService } from './organization-api-keys.service';

@Controller()
export class OrganizationApiKeysController {
  constructor(private readonly apiKeysService: OrganizationApiKeysService) {}

  @TsRestHandler(contract.listApiKeys)
  async listApiKeys() {
    return tsRestHandler(contract.listApiKeys, async ({ query }) => {
      const result = await this.apiKeysService.listApiKeys(query);
      return {
        status: 200 as const,
        body: result,
      };
    });
  }

  @TsRestHandler(contract.createApiKey)
  async createApiKey(@Req() req: Request) {
    return tsRestHandler(contract.createApiKey, async ({ body }) => {
      const headers = req.headers as Record<string, string>;
      const key = await this.apiKeysService.createApiKey(headers, {
        name: body.name!,
        expiresIn: body.expiresIn,
        permissions: body.permissions,
      });
      return {
        status: 201 as const,
        body: key,
      };
    });
  }

  @TsRestHandler(contract.getApiKey)
  async getApiKey() {
    return tsRestHandler(contract.getApiKey, async ({ params }) => {
      const key = await this.apiKeysService.getApiKey(params.apiKeyId);
      return {
        status: 200 as const,
        body: key,
      };
    });
  }

  @TsRestHandler(contract.updateApiKey)
  async updateApiKey() {
    return tsRestHandler(contract.updateApiKey, async ({ params, body }) => {
      const key = await this.apiKeysService.updateApiKey(params.apiKeyId, body.permissions);
      return {
        status: 200 as const,
        body: key,
      };
    });
  }

  @TsRestHandler(contract.deleteApiKey)
  async deleteApiKey() {
    return tsRestHandler(contract.deleteApiKey, async ({ params }) => {
      await this.apiKeysService.deleteApiKey(params.apiKeyId);
      return {
        status: 204 as const,
        body: undefined,
      };
    });
  }
}
