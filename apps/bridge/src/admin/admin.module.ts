import { type DynamicModule, Module, type Provider } from '@nestjs/common';

import {
  CRON_STATE_PROVIDER,
  type CronStateProvider,
  type CronStateSupervisorLike,
  emptyCronStateProvider,
  supervisorCronStateProvider,
} from './cron-state.js';
import { CronsController } from './crons.controller.js';

export interface AdminModuleOptions {
  cronSupervisor?: CronStateSupervisorLike | (() => CronStateSupervisorLike);
}

@Module({
  controllers: [CronsController],
  providers: [{ provide: CRON_STATE_PROVIDER, useValue: emptyCronStateProvider }],
  exports: [CRON_STATE_PROVIDER],
})
export class AdminModule {
  static forRoot(options: AdminModuleOptions = {}): DynamicModule {
    const supervisor = options.cronSupervisor;
    const provider: Provider =
      supervisor === undefined
        ? { provide: CRON_STATE_PROVIDER, useValue: emptyCronStateProvider }
        : {
            provide: CRON_STATE_PROVIDER,
            useFactory: (): CronStateProvider =>
              supervisorCronStateProvider(typeof supervisor === 'function' ? supervisor() : supervisor),
          };
    return {
      module: AdminModule,
      controllers: [CronsController],
      providers: [provider],
      exports: [CRON_STATE_PROVIDER],
    };
  }
}
