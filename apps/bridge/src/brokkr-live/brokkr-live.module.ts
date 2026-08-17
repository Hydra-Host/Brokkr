import { Module } from '@nestjs/common';

import { ContextLogger } from '../logger/logger.service';

import { AgentUnitRenderStartupService } from './agent-unit-render-startup.service';
import {
  BROKKR_LIVE_READINESS_LOGGER,
  BrokkrLiveReadinessServiceFactory,
  type BrokkrLiveReadinessLogger,
} from './brokkr-live-readiness.service';
import { BrokkrLiveServiceFactory } from './brokkr-live.service';
import { BrokkrLiveCheckStep } from './steps/brokkr-live-check.step';

const READINESS_APP_CLASS_NAME = 'brokkr-live-readiness';

function buildReadinessLogger(contextLogger: ContextLogger): BrokkrLiveReadinessLogger {
  return {
    info: (message, ctx) => contextLogger.info(message, { ...ctx, appClassName: READINESS_APP_CLASS_NAME }),
    error: (message, ctx) => contextLogger.error(message, { ...ctx, appClassName: READINESS_APP_CLASS_NAME }),
  };
}

@Module({
  providers: [
    {
      provide: AgentUnitRenderStartupService,
      useFactory: () => new AgentUnitRenderStartupService(),
    },
    {
      provide: BROKKR_LIVE_READINESS_LOGGER,
      useFactory: (contextLogger: ContextLogger) => buildReadinessLogger(contextLogger),
      inject: [ContextLogger],
    },
    BrokkrLiveReadinessServiceFactory,
    BrokkrLiveServiceFactory,
    {
      provide: BrokkrLiveCheckStep,
      useFactory: (factory: BrokkrLiveServiceFactory, logger: ContextLogger) =>
        new BrokkrLiveCheckStep(factory, logger),
      inject: [BrokkrLiveServiceFactory, ContextLogger],
    },
  ],
  exports: [
    AgentUnitRenderStartupService,
    BrokkrLiveReadinessServiceFactory,
    BrokkrLiveServiceFactory,
    BrokkrLiveCheckStep,
  ],
})
export class BrokkrLiveModule {}
