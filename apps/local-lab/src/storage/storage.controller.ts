import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { StorageService } from './storage.service';

@Controller()
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @TsRestHandler(contract.getStorageState)
  state() {
    return tsRestHandler(contract.getStorageState, async () => ({
      status: 200 as const,
      body: await this.storage.state(),
    }));
  }

  @TsRestHandler(contract.wipeStorage)
  @LabRoute({ exposure: 'loopback-only' })
  wipe() {
    return tsRestHandler(contract.wipeStorage, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.storage.wipe(body.category) },
    }));
  }

  @TsRestHandler(contract.resyncStorage)
  @LabRoute({ exposure: 'loopback-only' })
  resync() {
    return tsRestHandler(contract.resyncStorage, async () => ({
      status: 200 as const,
      body: { runId: this.storage.resync() },
    }));
  }

  @TsRestHandler(contract.verifyStorage)
  verify() {
    return tsRestHandler(contract.verifyStorage, async () => ({
      status: 200 as const,
      body: await this.storage.verify(),
    }));
  }
}
