import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { BuildService } from './build.service';

@Controller()
export class BuildController {
  constructor(private readonly build: BuildService) {}

  @TsRestHandler(contract.buildAgent)
  @LabRoute({ exposure: 'loopback-only' })
  agent() {
    return tsRestHandler(contract.buildAgent, async () => ({
      status: 200 as const,
      body: { runId: this.build.buildAgent() },
    }));
  }

  @TsRestHandler(contract.buildNetbootGrub)
  @LabRoute({ exposure: 'loopback-only' })
  netbootGrub() {
    return tsRestHandler(contract.buildNetbootGrub, async () => ({
      status: 200 as const,
      body: { runId: this.build.buildNetbootGrub() },
    }));
  }

  @TsRestHandler(contract.buildIpxe)
  @LabRoute({ exposure: 'loopback-only' })
  ipxe() {
    return tsRestHandler(contract.buildIpxe, async () => ({
      status: 200 as const,
      body: { runId: this.build.buildIpxe() },
    }));
  }
}
