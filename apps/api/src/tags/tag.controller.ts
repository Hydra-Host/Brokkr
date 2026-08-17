import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { TagService } from './tag.service';

@Controller()
export class TagController {
  constructor(private readonly service: TagService) {}

  @TsRestHandler(contract.listTags)
  async list() {
    return tsRestHandler(contract.listTags, async () => ({
      status: 200,
      body: await this.service.list(),
    }));
  }

  @TsRestHandler(contract.getTag)
  async getById() {
    return tsRestHandler(contract.getTag, async ({ params }) => ({
      status: 200,
      body: await this.service.findById(params.id),
    }));
  }

  @TsRestHandler(contract.createTag)
  async create() {
    return tsRestHandler(contract.createTag, async ({ body }) => ({
      status: 201,
      body: await this.service.create(body),
    }));
  }

  @TsRestHandler(contract.updateTag)
  async update() {
    return tsRestHandler(contract.updateTag, async ({ params, body }) => ({
      status: 200,
      body: await this.service.update(params.id, body),
    }));
  }

  @TsRestHandler(contract.deleteTag)
  async delete() {
    return tsRestHandler(contract.deleteTag, async ({ params }) => {
      await this.service.delete(params.id);
      return { status: 204 as const, body: undefined };
    });
  }
}
