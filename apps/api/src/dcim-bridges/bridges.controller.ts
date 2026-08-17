import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { BridgesService } from './bridges.service';

@Controller()
export class BridgesController {
  constructor(private readonly bridgesService: BridgesService) {}

  @TsRestHandler(contract.getBridges)
  async getBridges() {
    return tsRestHandler(contract.getBridges, async ({ query }) => {
      const result = await this.bridgesService.getBridgesPaginated(query);
      return { status: 200, body: result };
    });
  }

  @TsRestHandler(contract.getBridgeById)
  async getBridgeById() {
    return tsRestHandler(contract.getBridgeById, async ({ params }) => {
      const bridge = await this.bridgesService.getBridgeById(params.bridgeId);
      return { status: 200, body: bridge };
    });
  }
}
