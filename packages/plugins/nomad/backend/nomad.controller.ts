import { PluginOperatorGuard } from '@hydrahost/plugin-sdk/nest';
import { Controller, UseGuards } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contractFragment } from '../contract';
import { NomadJobsService } from './nomad-jobs.service';

@UseGuards(PluginOperatorGuard)
@Controller()
export class NomadController {
  constructor(private readonly jobs: NomadJobsService) {}

  @TsRestHandler(contractFragment.nomadHealth)
  health() {
    return tsRestHandler(contractFragment.nomadHealth, async () => ({
      status: 200 as const,
      body: { ok: true as const, pluginId: 'nomad' as const },
    }));
  }

  @TsRestHandler(contractFragment.nomadValidate)
  validate() {
    return tsRestHandler(contractFragment.nomadValidate, async ({ body }) => ({
      status: 200 as const,
      body: await this.jobs.validate(body),
    }));
  }

  @TsRestHandler(contractFragment.nomadPlan)
  plan() {
    return tsRestHandler(contractFragment.nomadPlan, async ({ body }) => ({
      status: 200 as const,
      body: await this.jobs.plan(body),
    }));
  }

  @TsRestHandler(contractFragment.nomadSubmit)
  submit() {
    return tsRestHandler(contractFragment.nomadSubmit, async ({ body }) => ({
      status: 200 as const,
      body: await this.jobs.submit(body),
    }));
  }

  @TsRestHandler(contractFragment.nomadStatus)
  status() {
    return tsRestHandler(contractFragment.nomadStatus, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobs.status(query),
    }));
  }

  @TsRestHandler(contractFragment.nomadDispatch)
  dispatch() {
    return tsRestHandler(contractFragment.nomadDispatch, async ({ body }) => ({
      status: 200 as const,
      body: await this.jobs.dispatch(body),
    }));
  }

  @TsRestHandler(contractFragment.nomadLogs)
  logs() {
    return tsRestHandler(contractFragment.nomadLogs, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobs.logs(query),
    }));
  }

  @TsRestHandler(contractFragment.nomadAllocs)
  allocs() {
    return tsRestHandler(contractFragment.nomadAllocs, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobs.allocs(query),
    }));
  }

  @TsRestHandler(contractFragment.nomadJob)
  job() {
    return tsRestHandler(contractFragment.nomadJob, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobs.readJob(query),
    }));
  }

  @TsRestHandler(contractFragment.nomadNodes)
  nodes() {
    return tsRestHandler(contractFragment.nomadNodes, async ({ query }) => ({
      status: 200 as const,
      body: await this.jobs.nodes(query),
    }));
  }

  @TsRestHandler(contractFragment.nomadStop)
  stop() {
    return tsRestHandler(contractFragment.nomadStop, async ({ body }) => ({
      status: 200 as const,
      body: await this.jobs.stop(body),
    }));
  }
}
