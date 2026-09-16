import { Controller, Param, Req, Sse } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import type { Request } from 'express';
import { map, Observable } from 'rxjs';

import { requestAllows } from '../common/lab-capability';
import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { OverlayStoreService } from './overlay-store';
import { ProcessComposeClient } from './process-compose.client';
import { ProcessEnvService } from './process-env.service';
import { RedeployService } from './redeploy.service';
import { RepoBranchService } from './repo-branch.service';
import { RosterService } from './roster.service';

@Controller()
export class ServicesController {
  constructor(
    private readonly redeployService: RedeployService,
    private readonly roster: RosterService,
    private readonly pc: ProcessComposeClient,
    private readonly overlay: OverlayStoreService,
    private readonly processEnv: ProcessEnvService,
    private readonly repoBranch: RepoBranchService,
  ) {}

  @TsRestHandler(contract.listServices)
  list() {
    return tsRestHandler(contract.listServices, async () => ({
      status: 200 as const,
      body: await this.roster.list(),
    }));
  }

  @TsRestHandler(contract.listAppLinks)
  listAppLinks() {
    return tsRestHandler(contract.listAppLinks, async () => ({
      status: 200 as const,
      body: await this.roster.listAppLinks(),
    }));
  }

  @TsRestHandler(contract.controlService)
  @LabRoute({ capability: 'admin' })
  control() {
    return tsRestHandler(contract.controlService, async ({ body }) => ({
      status: 200 as const,
      body: await this.redeployService.control(body.id, body.action),
    }));
  }

  @TsRestHandler(contract.reloadService)
  @LabRoute({ capability: 'admin' })
  reload() {
    return tsRestHandler(contract.reloadService, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.redeployService.reloadGroup(body.group).runId },
    }));
  }

  // the route itself is a read; only the reveal is root-equivalent, so the gate is field-level
  @TsRestHandler(contract.getProcessEnv)
  getProcessEnv(@Req() req: Request) {
    const mayReveal = requestAllows('host-exec', req);
    return tsRestHandler(contract.getProcessEnv, async ({ params, query }) => {
      const env = await this.processEnv.getProcessEnv(params.name, query.reveal === true && mayReveal);
      return env
        ? { status: 200 as const, body: env }
        : { status: 404 as const, body: { error: `unknown process: ${params.name}` } };
    });
  }

  @TsRestHandler(contract.getStackConfig)
  stackConfig() {
    return tsRestHandler(contract.getStackConfig, async () => ({
      status: 200 as const,
      body: this.overlay.stackConfig(),
    }));
  }

  // definedIn carries host filesystem paths, so this read is gated like listStacks rather than like
  // the other config reads.
  @TsRestHandler(contract.getConfigTree)
  @LabRoute({ capability: 'admin' })
  configTree() {
    return tsRestHandler(contract.getConfigTree, async () => ({
      status: 200 as const,
      body: this.overlay.configTree(),
    }));
  }

  @TsRestHandler(contract.putStackConfig)
  @LabRoute({ capability: 'admin' })
  putStackConfig() {
    return tsRestHandler(contract.putStackConfig, async ({ body }) => {
      const { applied, rejected } = await this.overlay.setStackConfig(body);
      return { status: 200 as const, body: { ok: true, applied, rejected } };
    });
  }

  @TsRestHandler(contract.redeployStack)
  @LabRoute({ capability: 'admin' })
  redeploy() {
    return tsRestHandler(contract.redeployStack, async () => ({
      status: 200 as const,
      body: { runId: this.redeployService.redeploy().runId },
    }));
  }

  @TsRestHandler(contract.getStackBranches)
  getStackBranches() {
    return tsRestHandler(contract.getStackBranches, async () => ({
      status: 200 as const,
      body: await this.repoBranch.branch(),
    }));
  }

  @TsRestHandler(contract.putStackBranches)
  @LabRoute({ capability: 'admin' })
  putStackBranches() {
    return tsRestHandler(contract.putStackBranches, async ({ body }) => ({
      status: 200 as const,
      body: await this.repoBranch.checkout(body.branch),
    }));
  }

  @Sse('api/services/:id/log')
  @LabRoute({ capability: 'admin' })
  log(@Param('id') id: string): Observable<{ data: { line: string } }> {
    return this.pc.streamLog(id).pipe(map((line) => ({ data: { line } })));
  }
}
