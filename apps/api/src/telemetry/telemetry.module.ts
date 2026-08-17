import { Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { shutdownTelemetry } from '@repo/telemetry';
import { TelemetrySpanEnrichmentInterceptor } from './telemetry-span-enrichment.interceptor';
import { WebVitalsController } from './web-vitals.controller';
import { WebVitalsService } from './web-vitals.service';

@Module({
  controllers: [WebVitalsController],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: TelemetrySpanEnrichmentInterceptor,
    },
    WebVitalsService,
  ],
})
export class TelemetryModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}
