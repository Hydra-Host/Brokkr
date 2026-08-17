import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { CloudInitTemplatesService } from './cloud-init-templates.service';

@Controller()
export class CloudInitTemplatesController {
  constructor(private readonly cloudInitTemplatesService: CloudInitTemplatesService) {}

  @TsRestHandler(contract.listCloudInitTemplates)
  async list() {
    return tsRestHandler(contract.listCloudInitTemplates, async ({ query }) => {
      const result = await this.cloudInitTemplatesService.list(query);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.updateCloudInitTemplate)
  async update() {
    return tsRestHandler(contract.updateCloudInitTemplate, async ({ params, body }) => {
      const result = await this.cloudInitTemplatesService.update(params.id, body);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.deleteCloudInitTemplate)
  async delete() {
    return tsRestHandler(contract.deleteCloudInitTemplate, async ({ params }) => {
      await this.cloudInitTemplatesService.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
