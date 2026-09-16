import { Controller, Get, Param, Sse, StreamableFile, UseFilters } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { createReadStream } from 'node:fs';
import { map, merge, Observable } from 'rxjs';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { ProcessComposeClient } from '../services/process-compose.client';
import { BootReadinessService } from './boot-readiness.service';
import { FleetExecService } from './fleet-exec.service';
import { FleetPowerService } from './fleet-power.service';
import { FleetResetService } from './fleet-reset.service';
import { FleetTopologyService } from './fleet-topology.service';
import { FleetVerifyService } from './fleet-verify.service';
import { RedfishExceptionFilter } from './redfish-exception.filter';

@Controller()
export class FleetController {
  constructor(
    private readonly fleet: FleetTopologyService,
    private readonly exec: FleetExecService,
    private readonly power: FleetPowerService,
    private readonly reset: FleetResetService,
    private readonly verify: FleetVerifyService,
    private readonly bootReadiness: BootReadinessService,
    private readonly pc: ProcessComposeClient,
  ) {}

  @TsRestHandler(contract.listMachines)
  machines() {
    return tsRestHandler(contract.listMachines, async () => ({
      status: 200 as const,
      body: await this.power.machines(),
    }));
  }

  @TsRestHandler(contract.powerMachine)
  @LabRoute({ capability: 'operate' })
  powerMachine() {
    return tsRestHandler(contract.powerMachine, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.power.power(body.name, body.action) },
    }));
  }

  @TsRestHandler(contract.discoverMachine)
  @LabRoute({ capability: 'operate' })
  discover() {
    return tsRestHandler(contract.discoverMachine, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.reset.discover(body.name) },
    }));
  }

  @TsRestHandler(contract.resetMachine)
  @LabRoute({ capability: 'operate' })
  resetMachine() {
    return tsRestHandler(contract.resetMachine, async ({ body }) => ({
      status: 200 as const,
      body: { runId: this.reset.reset(body.name) },
    }));
  }

  @TsRestHandler(contract.execMachine)
  @LabRoute({ capability: 'host-exec' })
  runMachineExec() {
    return tsRestHandler(contract.execMachine, async ({ body }) => ({
      status: 200 as const,
      body: await this.exec.runOnNode(body.name, body.command, body.user, body.timeout_s),
    }));
  }

  @TsRestHandler(contract.getMachineConsoleLog)
  consoleLog() {
    return tsRestHandler(contract.getMachineConsoleLog, async ({ params, query }) => ({
      status: 200 as const,
      body: this.exec.consoleLog(params.name, query.tail_bytes),
    }));
  }

  @Get('api/fleet/machines/:name/console-log/download')
  consoleLogDownload(@Param('name') name: string): StreamableFile {
    const path = this.exec.consoleLogPath(name);
    return new StreamableFile(createReadStream(path), {
      type: 'text/plain; charset=utf-8',
      disposition: `attachment; filename="${name}.log"`,
    });
  }

  @TsRestHandler(contract.getHost)
  host() {
    return tsRestHandler(contract.getHost, async () => ({ status: 200 as const, body: await this.fleet.hostInfo() }));
  }

  @TsRestHandler(contract.listPci)
  pci() {
    return tsRestHandler(contract.listPci, async () => ({ status: 200 as const, body: await this.fleet.pciDevices() }));
  }

  @TsRestHandler(contract.getFleetConfig)
  getConfig() {
    return tsRestHandler(contract.getFleetConfig, async () => ({
      status: 200 as const,
      body: await this.fleet.getConfig(),
    }));
  }

  @TsRestHandler(contract.getDevPubkey)
  devPubkey() {
    return tsRestHandler(contract.getDevPubkey, async () => ({ status: 200 as const, body: this.exec.devPubkey() }));
  }

  @TsRestHandler(contract.putFleetConfig)
  @LabRoute({ capability: 'admin' })
  putConfig() {
    return tsRestHandler(contract.putFleetConfig, async ({ body }) => {
      const rejected = this.fleet.putConfig({
        nodes: body.nodes,
        bmcDefaults: body.bmcDefaults,
        defaults: body.defaults,
        network: body.network,
        prune: body.prune,
        baremetal: body.baremetal,
      });
      return { status: 200 as const, body: { ok: true, pending: await this.fleet.pending(), rejected } };
    });
  }

  @TsRestHandler(contract.listHostNics)
  hostNics() {
    return tsRestHandler(contract.listHostNics, async () => ({ status: 200 as const, body: this.fleet.hostNics() }));
  }

  @UseFilters(RedfishExceptionFilter)
  @TsRestHandler(contract.baremetalPower)
  @LabRoute({ capability: 'operate' })
  baremetalPower() {
    return tsRestHandler(contract.baremetalPower, async ({ params, body }) => ({
      status: 200 as const,
      body: await this.power.baremetalPower(params.name, body.action),
    }));
  }

  @TsRestHandler(contract.getFleetApplyPlan)
  getApplyPlan() {
    return tsRestHandler(contract.getFleetApplyPlan, async () => ({
      status: 200 as const,
      body: await this.fleet.applyPlan(),
    }));
  }

  @TsRestHandler(contract.previewFleetApplyPlan)
  @LabRoute({ capability: 'operate' })
  previewApplyPlan() {
    return tsRestHandler(contract.previewFleetApplyPlan, async ({ body }) => ({
      status: 200 as const,
      body: await this.fleet.previewPlan(body),
    }));
  }

  @TsRestHandler(contract.getFleetVerify)
  getFleetVerify() {
    return tsRestHandler(contract.getFleetVerify, async () => ({
      status: 200 as const,
      body: await this.verify.verify(),
    }));
  }

  @TsRestHandler(contract.getFleetBootReadiness)
  getFleetBootReadiness() {
    return tsRestHandler(contract.getFleetBootReadiness, async ({ query }) => ({
      status: 200 as const,
      body: await this.bootReadiness.getBootReadiness(query.node),
    }));
  }

  @TsRestHandler(contract.getMachineBootTrail)
  getMachineBootTrail() {
    return tsRestHandler(contract.getMachineBootTrail, async ({ params }) => ({
      status: 200 as const,
      body: await this.bootReadiness.forMachine(params.name),
    }));
  }

  @TsRestHandler(contract.healFleet)
  @LabRoute({ capability: 'operate' })
  healFleet() {
    return tsRestHandler(contract.healFleet, async () => ({
      status: 200 as const,
      body: { runId: this.verify.heal() },
    }));
  }

  @Sse('api/fleet/process-logs/stream')
  @LabRoute({ capability: 'admin' })
  processLogs(): Observable<{ data: { line: string } }> {
    const tag = (name: string, src: Observable<string>) =>
      src.pipe(map((line) => ({ data: { line: `[${name}] ${line}` } })));
    return merge(tag('init', this.pc.streamTaskLog('fleet:init')), tag('fleet', this.pc.streamLog('fleet')));
  }
}
