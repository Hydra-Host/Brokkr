import { Module, type OnModuleInit, type Provider } from '@nestjs/common';

import { isRecord } from '@repo/utils';
import { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service';
import { Dispatcher } from '../agent/dispatch/dispatcher.service';
import { BrokkrLiveReadinessServiceFactory } from '../brokkr-live/brokkr-live-readiness.service';
import { BrokkrLiveModule } from '../brokkr-live/brokkr-live.module';
import type { ResultsService } from '../bullmq/results.service';
import { BULLMQ_RESULTS_SERVICE } from '../composition/composition-tokens';

import { ContextLogger } from '../logger/logger.service';
import { OobModule } from '../oob/oob.module';
import { PowerManagementServiceFactory } from '../oob/power/power-management.service';
import { SolServiceFactory } from '../oob/sol/sol.factory';
import { registerSagaDef } from '../saga-framework/saga-registry';
import {
  SerialPortProbeService,
  type SolProbeMatch,
  type SolProbeResult,
} from '../serial-port-probe/serial-port-probe.service';

import { buildInventoryCollectionSaga } from './collection.workflow';
import { CollectHardwareStep } from './steps/collect-hardware.step';
import { ProbeSerialPortStep } from './steps/probe-serial-port.step';
import { WaitForBrokkrLiveStep } from './steps/wait-for-brokkr-live.step';

function coerceSolProbeResult(raw: Record<string, unknown>): SolProbeResult {
  const matchesRaw = raw['matches'];
  const matches: SolProbeMatch[] = Array.isArray(matchesRaw)
    ? matchesRaw.map((m) => {
        const rec: Record<string, unknown> = isRecord(m) ? m : {};
        const token = rec['token'];
        const atSeconds = rec['at_seconds'];
        return {
          token: typeof token === 'string' ? token : undefined,
          at_seconds: typeof atSeconds === 'number' ? atSeconds : undefined,
        };
      })
    : [];
  return {
    matches,
    lines_seen: typeof raw['lines_seen'] === 'number' ? raw['lines_seen'] : undefined,
    duration_seconds: typeof raw['duration_seconds'] === 'number' ? raw['duration_seconds'] : null,
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  };
}

const probeSerialPortStepProvider: Provider = {
  provide: ProbeSerialPortStep,
  useFactory: (dispatcher: Dispatcher, solFactory: SolServiceFactory, results: ResultsService, logger: ContextLogger) =>
    new ProbeSerialPortStep(
      {
        create: async (jobId: string, sagaOptions?: { signal?: AbortSignal; workId?: string }) => {
          let dispatchIndex = 0;
          const solService = await solFactory.create(jobId);
          const svc = new SerialPortProbeService(jobId, {
            solService: {
              probeForTokens: async (params) => coerceSolProbeResult(await solService.probeForTokens(params)),
            },
            dispatchFn: (deviceId, opName, payload, options) =>
              dispatcher.dispatchTyped(deviceId, opName, payload, {
                jobId: options.jobId,
                timeoutS: options.timeoutS,
                signal: sagaOptions?.signal,
                workId: sagaOptions?.workId === undefined ? undefined : `${sagaOptions.workId}:${dispatchIndex++}`,
              }),
            logger,
          });
          return {
            probe: (args) =>
              svc.probe({
                deviceId: args.deviceId,
                bmcIp: args.bmcIp,
                bmcUsername: args.bmcUsername,
                bmcPassword: args.bmcPassword,
              }),
          };
        },
      },
      results,
      logger,
    ),
  inject: [Dispatcher, SolServiceFactory, BULLMQ_RESULTS_SERVICE, ContextLogger],
};

@Module({
  imports: [BrokkrLiveModule, OobModule],
  providers: [
    {
      provide: WaitForBrokkrLiveStep,
      useFactory: (
        factory: BrokkrLiveReadinessServiceFactory,
        logger: ContextLogger,
        powerFactory: PowerManagementServiceFactory,
      ) => new WaitForBrokkrLiveStep(factory, logger, powerFactory),
      inject: [BrokkrLiveReadinessServiceFactory, ContextLogger, PowerManagementServiceFactory],
    },
    {
      provide: CollectHardwareStep,
      useFactory: (
        dispatcher: Dispatcher,
        registry: ConnectionRegistry,
        results: ResultsService,
        logger: ContextLogger,
      ) => new CollectHardwareStep(dispatcher, registry, results, logger),
      inject: [Dispatcher, ConnectionRegistry, BULLMQ_RESULTS_SERVICE, ContextLogger],
    },
    probeSerialPortStepProvider,
  ],
  exports: [WaitForBrokkrLiveStep, CollectHardwareStep, ProbeSerialPortStep],
})
export class CollectionModule implements OnModuleInit {
  constructor(
    private readonly waitForBrokkrLive: WaitForBrokkrLiveStep,
    private readonly collectHardware: CollectHardwareStep,
    private readonly probeSerialPort: ProbeSerialPortStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildInventoryCollectionSaga({
        waitForBrokkrLive: this.waitForBrokkrLive,
        collectHardware: this.collectHardware,
        probeSerialPort: this.probeSerialPort,
      }),
    );
  }
}
