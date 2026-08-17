import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { Public } from 'src/auth/decorators/public.decorator';
import { InventoryService } from './inventory.service';

@Controller()
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Public()
  @TsRestHandler(contract.getInventory)
  async getInventory() {
    return tsRestHandler(contract.getInventory, async ({ query }) => {
      const result = await this.inventoryService.getListings(query.filters, query.page, query.pageSize);
      return { status: 200 as const, body: result };
    });
  }

  @TsRestHandler(contract.getRegions)
  async getRegions() {
    return tsRestHandler(contract.getRegions, async ({ query }) => {
      const paginated = await this.inventoryService.getRegions(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @Public()
  @TsRestHandler(contract.getCategoryPrices)
  async getCategoryPrices() {
    return tsRestHandler(contract.getCategoryPrices, async ({ query }) => {
      const paginated = await this.inventoryService.getCategoryPrices(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @Public()
  @TsRestHandler(contract.getCategoryAvailability)
  async getCategoryAvailability() {
    return tsRestHandler(contract.getCategoryAvailability, async ({ query }) => {
      const paginated = await this.inventoryService.getCategoryAvailability(query);
      return { status: 200 as const, body: paginated };
    });
  }

  @TsRestHandler(contract.getInventoryById)
  async getInventoryById() {
    return tsRestHandler(contract.getInventoryById, async ({ params }) => {
      const listing = await this.inventoryService.getListingById(params.id);
      return { status: 200 as const, body: listing };
    });
  }

  @TsRestHandler(contract.provisionDevice)
  async provisionDevice() {
    return tsRestHandler(contract.provisionDevice, async ({ params, body }) => {
      await this.inventoryService.provisionDirectProvisionDevice({
        ...body,
        deviceId: params.id,
      });
      return { status: 200 as const, body: { success: true } };
    });
  }
}
