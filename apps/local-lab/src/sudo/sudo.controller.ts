import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { SudoService } from './sudo.service';

@Controller()
export class SudoController {
  constructor(private readonly sudo: SudoService) {}

  @TsRestHandler(contract.getSudoStatus)
  status() {
    return tsRestHandler(contract.getSudoStatus, async () => ({
      status: 200 as const,
      body: { available: await this.sudo.available() },
    }));
  }

  @TsRestHandler(contract.cacheSudo)
  @LabRoute({ capability: 'host-exec' })
  cache() {
    return tsRestHandler(contract.cacheSudo, async ({ body }) => {
      const ok = await this.sudo.cache(body.password);
      return ok
        ? { status: 200 as const, body: { ok: true } }
        : { status: 401 as const, body: { error: 'sudo password rejected' } };
    });
  }
}
